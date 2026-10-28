#!/usr/bin/env python3
"""Small, dependency-free project workspace with transactional SQLite storage."""
import argparse
import base64
import binascii
import datetime as dt
import hashlib
import hmac
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import threading
import time
import uuid
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from work_calendar import DEFAULT_CALENDARS, calendar_from_text, calculate_workload, enrich_task, project_metrics
from work_import import ImportProblem, MAX_FILE, parse_document, read_link

ROOT = Path(__file__).resolve().parent
STATUSES = ['待确认', '未开始', '进行中', '待验收', '受阻', '已延期', '暂停', '已完成']
TEXT_FIELDS = ['id', 'stage', 'title', 'content', 'owner', 'collaborator', 'start', 'end',
               'status', 'priority', 'originalAction', 'originalDeliverable', 'nextAction',
               'criteria', 'followup', 'blocker', 'decision', 'evidence', 'actualEnd', 'acceptance']
DATE_FIELDS = ['start', 'end', 'followup', 'actualEnd']


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds')


def hash_password(password):
    salt = secrets.token_hex(16)
    return salt + ':' + hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 600000).hex()


def password_matches(password, stored):
    salt, expected = stored.split(':')
    digest = hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 600000).hex()
    return hmac.compare_digest(expected, digest)


def validate_password(value):
    if not isinstance(value, str) or not 12 <= len(value) <= 128 or not value.strip():
        raise APIError(400, '密码需要 12 至 128 个字符，不能全为空格')
    return value


def validate_username(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{3,31}', value.strip()):
        raise APIError(400, '账号需要 4 至 32 位，以字母或数字开头，可包含字母、数字、点、横线和下划线')
    return value.strip().lower()


def new_recovery_code():
    raw = secrets.token_hex(16).upper()
    return 'RC-' + '-'.join(raw[i:i+4] for i in range(0, len(raw), 4))


def hash_recovery_code(code):
    normalized = re.sub(r'[\s-]', '', code).upper()
    return hashlib.sha256(normalized.encode()).hexdigest()


def public_user(row):
    return {'id': row['id'], 'username': row['username'], 'displayName': row['display_name'], 'role': row['role']}


class APIError(Exception):
    def __init__(self, status, message, **extra):
        self.status, self.message, self.extra = status, message, extra


def validate_task(value):
    if not isinstance(value, dict):
        raise APIError(400, '任务格式无效')
    task = {}
    for key in TEXT_FIELDS:
        field = value.get(key, '')
        if not isinstance(field, str) or len(field) > (30000 if key in ['content', 'evidence', 'nextAction', 'blocker', 'decision', 'criteria'] else 2000):
            raise APIError(400, '字段格式或长度无效：' + key)
        task[key] = field.strip()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', task['id']):
        raise APIError(400, '任务编号仅支持字母、数字、点、横线和下划线')
    if not task['title'] or not task['stage']:
        raise APIError(400, '请填写任务名称和项目阶段')
    if task['status'] not in STATUSES or task['priority'] not in ['', '待确认', '高', '中', '低']:
        raise APIError(400, '状态或优先级无效')
    if task['acceptance'] not in ['', '待验收', '验收通过', '需整改', '不适用']:
        raise APIError(400, '验收结论无效')
    progress = value.get('progress')
    if progress is not None and (type(progress) not in (int, float) or not 0 <= progress <= 1):
        raise APIError(400, '完成率必须在 0% 到 100% 之间')
    task['progress'] = progress
    if task['status'] == '已完成' and progress != 1:
        raise APIError(400, '已完成任务的完成率应为 100%')
    for key in DATE_FIELDS:
        if task[key]:
            try:
                if dt.date.fromisoformat(task[key]).isoformat() != task[key]:
                    raise ValueError()
            except ValueError:
                raise APIError(400, '日期无效：' + key)
    if task['start'] and task['end'] and task['end'] < task['start']:
        raise APIError(400, '计划结束日期不能早于开始日期')
    task['sourceRow'] = value.get('sourceRow') if type(value.get('sourceRow')) is int else None
    return task


def generate_tasks(content):
    """Extract explicit work items; do not invent dates, owners or factual progress."""
    if not isinstance(content, str) or not 2 <= len(content.strip()) <= 100000:
        raise APIError(400, '请填写 2 至 100000 字的项目内容')
    lines = [re.sub(r'^\s*(?:[-*•]|\d+[.、)）]|[一二三四五六七八九十]+、)\s*', '', s).strip()
             for s in re.split(r'\n|[；;]', content)]
    lines = [s for s in lines if s and not re.fullmatch(r'[#\s]*(?:项目内容|项目计划|待办事项|任务清单)[:：]?', s)]
    if len(lines) == 1:
        lines = [s.strip() for s in re.split(r'[。！？]', lines[0]) if s.strip()]
    tasks, stage = [], '项目实施'
    for line in lines:
        if re.fullmatch(r'(?:#{1,4}\s+.+|.{2,25}[:：])', line) and not re.search(r'(?:负责人|截止|交付物|交付成果)[:：]', line):
            stage = re.sub(r'^#+\s*|[:：]$', '', line)
            continue
        if len(tasks) >= 200:
            raise APIError(400, '一次最多提取 200 项任务，请分批创建')
        dates = []
        for year, month, day in re.findall(r'(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?', line):
            try:
                dates.append(dt.date(int(year), int(month), int(day)).isoformat())
            except ValueError:
                pass
        owner = re.search(r'(?:负责人|主责人|责任人|owner)\s*[:：]\s*([^，,。;；|\s]+)', line, re.I)
        deliverable = re.search(r'(?:交付物|交付成果|验收标准)\s*[:：]\s*(.+)', line)
        title = re.split(r'[|｜]|(?:负责人|主责人|责任人|截止|计划开始|交付物|验收标准)\s*[:：]', line)[0].strip(' ，,：:')
        if not title:
            title = line
        tasks.append(validate_task({
            'id': 'T-' + str(len(tasks) + 1).zfill(3), 'title': title[:120],
            'stage': stage, 'content': line, 'owner': owner.group(1) if owner else '',
            'start': dates[0] if len(dates) > 1 else '', 'end': dates[-1] if dates else '',
            'status': '未开始', 'priority': '高' if re.search(r'紧急|高优先级|P0|P1', line, re.I) else '中',
            'progress': 0, 'nextAction': '确认执行范围、负责人及排期；推进「' + title[:100] + '」。',
            'criteria': deliverable.group(1) if deliverable else '',
        }))
    if not tasks:
        raise APIError(400, '未找到可生成的任务，请按行填写具体工作事项')
    return tasks


def validate_project(value):
    result = {}
    for field in ['name', 'description', 'content', 'owner', 'start', 'end']:
        text = value.get(field, '')
        if not isinstance(text, str) or len(text) > (100000 if field == 'content' else 5000):
            raise APIError(400, '项目字段格式或长度无效：' + field)
        result[field] = text.strip()
    if not result['name'] or len(result['name']) > 100:
        raise APIError(400, '项目名称应为 1 至 100 字')
    for key in ['start', 'end']:
        if result[key]:
            try:
                if dt.date.fromisoformat(result[key]).isoformat() != result[key]:
                    raise ValueError()
            except ValueError:
                raise APIError(400, '项目日期格式无效')
    if result['start'] and result['end'] and result['start'] > result['end']:
        raise APIError(400, '项目结束日期不能早于开始日期')
    return result


class Store:
    def __init__(self, directory):
        self.directory = Path(directory).resolve()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'project.sqlite3'
        self.backup_dir = self.directory / 'backups'
        self.backup_dir.mkdir(exist_ok=True, mode=0o700)
        self.backup_lock = threading.Lock()
        # Preserve a complete pre-migration database before changing legacy authentication.
        if self.path.exists() and self.path.stat().st_size:
            with self.connect() as existing:
                needs_migration = not existing.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
            if needs_migration:
                self.backup()
        with self.connect() as db:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL,
                    version INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS tasks(project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, data TEXT NOT NULL,
                    version INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL, PRIMARY KEY(project_id,id));
                CREATE TABLE IF NOT EXISTS revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,
                    project_id TEXT NOT NULL REFERENCES projects(id), task_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
                    archived INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(project_id,task_id, version));
                CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
                    display_name TEXT NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'member', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS auth_attempts(scope TEXT NOT NULL, subject TEXT NOT NULL, at REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS auth_attempts_lookup ON auth_attempts(scope,subject,at);
                CREATE TABLE IF NOT EXISTS work_calendars(user_id TEXT NOT NULL REFERENCES users(id), year INTEGER NOT NULL,
                    data TEXT NOT NULL, version INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id,year));
                CREATE TABLE IF NOT EXISTS calendar_revisions(user_id TEXT NOT NULL REFERENCES users(id), year INTEGER NOT NULL,
                    version INTEGER NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(user_id,year,version));
                CREATE TABLE IF NOT EXISTS import_batches(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
                    user_id TEXT NOT NULL REFERENCES users(id), data TEXT NOT NULL, versions TEXT NOT NULL,
                    created_at TEXT NOT NULL, applied_at TEXT, request_hash TEXT, result TEXT);
            ''')
            db.execute('BEGIN IMMEDIATE')
            if not db.execute("SELECT 1 FROM meta WHERE key='initialized'").fetchone():
                seed = json.loads((ROOT / 'seed/project.json').read_text())
                db.execute('INSERT INTO projects VALUES (?, ?, ?, ?, ?)', ('haikang', json.dumps({
                    'name': '海康 × 致趣', 'subtitle': 'SCMA 项目协作空间',
                    'description': '从项目计划到交付验收，让每一项工作清晰可追踪。',
                    'content': '原计划共 50 项任务，保留原计划正文、负责人、排期和建议验收要点。',
                    'owner': 'SCMA 项目组', 'start': '', 'end': '',
                    'source': seed['source'], 'sourceDate': seed['asof']}, ensure_ascii=False), 1, 0, now()))
                for task in seed['tasks']:
                    self.write(db, 'haikang', validate_task(task), 0, '导入原始项目计划')
                db.execute("INSERT INTO meta VALUES ('initialized', '1')")
            if not db.execute('SELECT 1 FROM users LIMIT 1').fetchone() and not db.execute("SELECT 1 FROM meta WHERE key='password'").fetchone():
                password = os.environ.get('BOARD_PASSWORD') or secrets.token_urlsafe(15)
                if len(password) < 12:
                    raise RuntimeError('BOARD_PASSWORD 至少需要 12 个字符')
                db.execute('INSERT INTO meta VALUES (?, ?)', ('password', hash_password(password)))
                if not os.environ.get('BOARD_PASSWORD'):
                    credential = self.directory / '首次登录密码.txt'
                    credential.write_text('序 · 项目工作台\n登录账号：admin\n初始登录密码：' + password + '\n此文件仅记录初始密码，修改后以新密码为准。请妥善保管，不要上传 GitHub。\n')
                    credential.chmod(0o600)
                    print('首次登录密码已保存至：' + str(credential), flush=True)
            if not db.execute('SELECT 1 FROM users LIMIT 1').fetchone():
                legacy = db.execute("SELECT value FROM meta WHERE key='password'").fetchone()[0]
                recovery = new_recovery_code()
                db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                           ('admin', 'admin', '项目管理员', legacy, hash_recovery_code(recovery), 'admin', now(), now()))
                credential = self.directory / '管理员账号与恢复码.txt'
                credential.write_text('登录账号：admin\n初始密码：沿用原空间密码（如为自动生成，见首次登录密码.txt）\n'
                                      '初始密码恢复码：' + recovery + '\n恢复码使用一次后自动更换，请妥善保存新码。\n此文件不要上传 GitHub。\n')
                credential.chmod(0o600)
                print('管理员账号说明和初始恢复码已保存至：' + str(credential), flush=True)
            if 'user_id' not in [r['name'] for r in db.execute('PRAGMA table_info(sessions)')]:
                db.execute('DELETE FROM sessions')
                db.execute('ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)')
            if 'owner_id' not in [r['name'] for r in db.execute('PRAGMA table_info(projects)')]:
                db.execute('ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id)')
                db.execute("UPDATE projects SET owner_id='admin' WHERE owner_id IS NULL")
            db.execute("DELETE FROM meta WHERE key='password'")
            db.execute("INSERT OR REPLACE INTO meta VALUES('auth_schema', '2')")
        self.path.chmod(0o600)
        self.backup()

    def connect(self):
        db = sqlite3.connect(str(self.path), timeout=15)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA synchronous=FULL')
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA busy_timeout=15000')
        return db

    def task(self, row):
        return {**json.loads(row['data']), 'version': row['version'],
                'archived': bool(row['archived']), 'updatedAt': row['updated_at']}

    def calendars(self, user_id, db=None):
        if db is None:
            with self.connect() as connection:
                return self.calendars(user_id, connection)
        calendars = {year: {**data, 'version': 0, 'custom': False} for year, data in DEFAULT_CALENDARS.items()}
        for row in db.execute('SELECT * FROM work_calendars WHERE user_id=?', (user_id,)):
            calendars[str(row['year'])] = {**json.loads(row['data']), 'version': row['version'], 'custom': True, 'updatedAt': row['updated_at']}
        return calendars

    def write(self, db, project_id, task, previous, action, archived=False):
        version, stamp = previous + 1, now()
        raw = json.dumps(task, ensure_ascii=False, allow_nan=False)
        db.execute('INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id,id) DO UPDATE SET '
                   'data=excluded.data, version=excluded.version, archived=excluded.archived, updated_at=excluded.updated_at',
                   (project_id, task['id'], raw, version, int(archived), stamp))
        db.execute('INSERT INTO revisions(project_id,task_id,version,data,archived,action,created_at) VALUES(?,?,?,?,?,?,?)',
                   (project_id, task['id'], version, raw, int(archived), action, stamp))
        return {**task, 'version': version, 'archived': bool(archived), 'updatedAt': stamp}

    def backup(self):
        with self.backup_lock:
            name = 'project-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S-%fZ') + '.sqlite3'
            target = self.backup_dir / name
            temporary = target.with_suffix('.tmp')
            try:
                with self.connect() as source, sqlite3.connect(str(temporary)) as dest:
                    source.backup(dest)
                    if dest.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                        raise RuntimeError('备份完整性检查失败')
                temporary.chmod(0o600)
                temporary.replace(target)
                self.backup_error = None
                self.last_backup = now()
                return target
            except Exception as exc:
                self.backup_error = str(exc)
                raise

    def snapshot(self, project_id):
        with self.connect() as db:
            db.execute('BEGIN')
            row = db.execute('SELECT * FROM projects WHERE id=?', (project_id,)).fetchone()
            if not row:
                raise APIError(404, '项目不存在')
            project = {**json.loads(row['data']), 'id': row['id'], 'version': row['version'], 'archived': bool(row['archived'])}
            calendars = self.calendars(row['owner_id'], db)
            tasks = [enrich_task(self.task(r), calendars) for r in db.execute('SELECT * FROM tasks WHERE project_id=? ORDER BY id', (project_id,))]
            summary = project_metrics(tasks)
            return {'format': 'project-board-v1', 'exportedAt': now(), 'project': project, 'tasks': tasks,
                    'summary': summary, 'workCalendar': {'region': 'CN', 'hoursPerDay': 8, 'inclusive': True, 'years': calendars}}


class Handler(BaseHTTPRequestHandler):
    server_version = 'ProjectBoard'

    def log_message(self, fmt, *args):
        if self.path != '/api/health':
            super().log_message(fmt, *args)

    @property
    def store(self):
        return self.server.store

    def respond(self, status, data, headers=None, content_type='application/json; charset=utf-8'):
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        for key, value in {'Content-Type': content_type, 'Content-Length': str(len(raw)),
                           'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
                           'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
                           'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", **(headers or {})}.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length < 1 or length > 4_000_000:
                raise APIError(413, '提交内容过大或为空')
            value = json.loads(self.rfile.read(length), parse_constant=lambda _: None)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise APIError(400, '提交内容不是有效的 JSON 对象')

    def session(self):
        try:
            jar = cookies.SimpleCookie(self.headers.get('Cookie', ''))
            token = jar['board_session'].value
        except (KeyError, cookies.CookieError):
            raise APIError(401, '请先登录项目空间')
        with self.store.connect() as db:
            row = db.execute('SELECT s.*, u.id, u.username, u.display_name, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires>?',
                             (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        if not row:
            raise APIError(401, '登录已过期，请重新登录；未保存的草稿会保留')
        return row

    def check_origin(self):
        origin = self.headers.get('Origin')
        if self.headers.get('Sec-Fetch-Site') == 'cross-site':
            raise APIError(403, '请从项目页面提交')
        allowed = os.environ.get('BOARD_ORIGIN')
        if origin and origin != (allowed or ('http://' + self.headers.get('Host', ''))):
            raise APIError(403, '页面来源校验失败')
        if self.headers.get('X-Requested-With') != 'ProjectBoard':
            raise APIError(403, '请从项目页面提交')

    def do_GET(self):
        self.handle_request('GET')

    def do_POST(self):
        self.handle_request('POST')

    def do_PUT(self):
        self.handle_request('PUT')

    def handle_request(self, method):
        try:
            self.route(method, urlparse(self.path).path)
        except APIError as exc:
            self.respond(exc.status, {'error': exc.message, **exc.extra})
        except ImportProblem as exc:
            self.respond(400, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            print('请求失败：' + repr(exc), flush=True)
            self.respond(500, {'error': '保存或读取失败，草稿会保留，请稍后重试'})

    def route(self, method, path):
        if method == 'GET' and path == '/api/health':
            with self.store.connect() as db:
                db.execute('SELECT 1').fetchone()
            return self.respond(200, {'ok': True})
        if not path.startswith('/api/'):
            files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/auth.css': 'auth.css',
                     '/worklist.css': 'worklist.css', '/dashboard.css': 'dashboard.css', '/dashboard.js': 'dashboard.js',
                     '/importer.js': 'importer.js', '/importer.css': 'importer.css', '/favicon.svg': 'favicon.svg'}
            if method != 'GET' or path not in files:
                raise APIError(404, '页面不存在')
            file = ROOT / 'static' / files[path]
            return self.respond(200, file.read_bytes(), content_type=(mimetypes.guess_type(file)[0] or 'text/plain') + '; charset=utf-8')
        if method != 'GET':
            self.check_origin()
        if path in ['/api/login', '/api/register', '/api/reset-password'] and method == 'POST':
            body = self.body()
            {'/api/login': self.login, '/api/register': self.register,
             '/api/reset-password': self.reset_password}[path](body)
            return
        session = self.session()
        if method != 'GET' and not hmac.compare_digest(self.headers.get('X-CSRF-Token', ''), session['csrf']):
            raise APIError(403, '登录校验已失效，请刷新页面后重试')
        if path == '/api/session' and method == 'GET':
            return self.respond(200, {'csrf': session['csrf'], 'user': public_user(session)})
        if path == '/api/change-password' and method == 'POST':
            return self.change_password(session, self.body())
        if path == '/api/calendar' and method == 'GET':
            return self.respond(200, {'region': 'CN', 'hoursPerDay': 8, 'years': self.store.calendars(session['user_id'])})
        if path == '/api/work-hours' and method == 'POST':
            body = self.body()
            return self.respond(200, {'workload': calculate_workload(body.get('start'), body.get('end'), self.store.calendars(session['user_id']))})
        calendar_match = re.fullmatch(r'/api/calendar/(\d{4})', path)
        if calendar_match and method == 'PUT':
            body = self.body()
            year = int(calendar_match.group(1))
            try:
                data = calendar_from_text(year, body)
            except (ValueError, TypeError) as exc:
                raise APIError(400, str(exc))
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                previous = db.execute('SELECT version FROM work_calendars WHERE user_id=? AND year=?', (session['user_id'], year)).fetchone()
                version = previous['version'] if previous else 0
                if type(body.get('version')) is not int or body['version'] != version:
                    raise APIError(409, '工作日历已在其他页面更新，请重新打开后保存')
                raw, stamp = json.dumps(data, ensure_ascii=False), now()
                db.execute('INSERT INTO work_calendars VALUES(?,?,?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET '
                           'data=excluded.data, version=excluded.version, updated_at=excluded.updated_at',
                           (session['user_id'], year, raw, version+1, stamp))
                db.execute('INSERT INTO calendar_revisions VALUES(?,?,?,?,?)', (session['user_id'], year, version+1, raw, stamp))
            return self.respond(200, {'ok': True, 'calendar': {**data, 'version': version+1, 'custom': True}})
        if path == '/api/logout' and method == 'POST':
            with self.store.connect() as db:
                db.execute('DELETE FROM sessions WHERE token=?', (session['token'],))
            return self.respond(200, {'ok': True}, {'Set-Cookie': 'board_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'})
        if path == '/api/generate' and method == 'POST':
            return self.respond(200, {'tasks': generate_tasks(self.body().get('content'))})
        if path == '/api/projects' and method == 'GET':
            with self.store.connect() as db:
                db.execute('BEGIN')
                projects = []
                calendars = self.store.calendars(session['user_id'], db)
                for r in db.execute('SELECT * FROM projects WHERE owner_id=? ORDER BY updated_at DESC', (session['user_id'],)):
                    task_rows = db.execute('SELECT data FROM tasks WHERE project_id=? AND archived=0', (r['id'],)).fetchall()
                    tasks = [enrich_task(json.loads(t['data']), calendars) for t in task_rows]
                    summary = project_metrics(tasks)
                    projects.append({**json.loads(r['data']), 'id': r['id'], 'version': r['version'],
                                     'archived': bool(r['archived']), 'updatedAt': r['updated_at'],
                                     **summary, 'summary': summary})
            return self.respond(200, {'projects': projects})
        if path == '/api/projects' and method == 'POST':
            body = self.body()
            project = validate_project(body)
            raw_tasks = body.get('tasks', [])
            if not isinstance(raw_tasks, list) or len(raw_tasks) > 200:
                raise APIError(400, '初始任务格式无效或超过 200 项')
            tasks = [validate_task(t) for t in raw_tasks]
            if len(set(t['id'] for t in tasks)) != len(tasks):
                raise APIError(400, '任务编号重复')
            project_id = uuid.uuid4().hex[:16]
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                db.execute('INSERT INTO projects(id,data,version,archived,updated_at,owner_id) VALUES(?,?,?,?,?,?)',
                           (project_id, json.dumps(project, ensure_ascii=False), 1, 0, now(), session['user_id']))
                for task in tasks:
                    self.store.write(db, project_id, task, 0, '根据项目内容生成')
            return self.respond(201, {'project': {**project, 'id': project_id, 'version': 1, 'archived': False}})
        project_match = re.fullmatch(r'/api/projects/([A-Za-z0-9_-]+)(/.*)?', path)
        if not project_match:
            raise APIError(404, '接口不存在')
        project_id, suffix = project_match.groups()
        with self.store.connect() as db:
            if method != 'GET':
                db.execute('BEGIN IMMEDIATE')
            project_row = db.execute('SELECT * FROM projects WHERE id=? AND owner_id=?', (project_id, session['user_id'])).fetchone()
            if not project_row:
                raise APIError(404, '项目不存在')
            if (not suffix and method == 'PUT') or (suffix == '/archive' and method == 'POST'):
                body = self.body()
                if type(body.get('version')) is not int or body['version'] != project_row['version']:
                    raise APIError(409, '项目信息已被其他页面修改，请刷新后重试')
                data = json.loads(project_row['data'])
                archived = bool(project_row['archived'])
                if suffix:
                    archived = not archived
                else:
                    data = {**data, **validate_project(body)}
                db.execute('UPDATE projects SET data=?, version=version+1, archived=?, updated_at=? WHERE id=?',
                           (json.dumps(data, ensure_ascii=False), int(archived), now(), project_id))
                db.commit()
                return self.respond(200, {'ok': True})
            if project_row['archived'] and method != 'GET':
                raise APIError(409, '请先从回收站恢复项目再编辑')
        path = '/api' + (suffix or '/project')
        if path == '/api/project' and method == 'GET':
            return self.respond(200, {**self.store.snapshot(project_id), 'backup': {
                'lastAt': self.store.last_backup, 'error': self.store.backup_error}})
        if path == '/api/export' and method == 'GET':
            return self.respond(200, self.store.snapshot(project_id), {'Content-Disposition': 'attachment; filename="project-backup.json"'})
        if path == '/api/backup' and method == 'POST':
            self.store.backup()
            return self.respond(200, {'ok': True, 'lastAt': self.store.last_backup})
        if path == '/api/import' and method == 'POST':
            return self.import_tasks(project_id, self.body())
        if path == '/api/import-preview' and method == 'POST':
            return self.import_preview(project_id, session['user_id'], self.body())
        batch_match = re.fullmatch(r'/api/import-batches/([a-f0-9]{32})(/save)?', path)
        if batch_match:
            batch_id, save = batch_match.groups()
            if save and method == 'POST':
                return self.save_import(project_id, session['user_id'], batch_id, self.body())
            if not save and method == 'GET':
                with self.store.connect() as db:
                    batch = db.execute('SELECT * FROM import_batches WHERE id=? AND project_id=? AND user_id=?',
                                       (batch_id, project_id, session['user_id'])).fetchone()
                if not batch:
                    raise APIError(404, '导入预览不存在，请重新读取文件')
                return self.respond(200, {**json.loads(batch['data']), 'batchId': batch_id,
                                          'result': json.loads(batch['result']) if batch['result'] else None})
        if path == '/api/tasks' and method == 'POST':
            task = validate_task(self.body())
            with self.store.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                if db.execute('SELECT 1 FROM tasks WHERE project_id=? AND id=?', (project_id, task['id'])).fetchone():
                    raise APIError(409, '任务编号已存在，请换一个编号')
                result = self.store.write(db, project_id, task, 0, '新建任务')
            return self.respond(201, {'task': enrich_task(result, self.store.calendars(session['user_id']))})
        match = re.fullmatch(r'/api/tasks/([A-Za-z0-9_.-]+)(?:/(history|restore|archive))?', path)
        if match:
            task_id, action = match.groups()
            with self.store.connect() as db:
                if method != 'GET':
                    db.execute('BEGIN IMMEDIATE')
                row = db.execute('SELECT * FROM tasks WHERE project_id=? AND id=?', (project_id, task_id)).fetchone()
                if not row:
                    raise APIError(404, '任务不存在')
                if action == 'history' and method == 'GET':
                    history = [{'version': r['version'], 'action': r['action'], 'at': r['created_at'],
                                'archived': bool(r['archived']), 'task': json.loads(r['data'])}
                               for r in db.execute('SELECT * FROM revisions WHERE project_id=? AND task_id=? ORDER BY version DESC', (project_id, task_id))]
                    return self.respond(200, {'history': history})
                if (method == 'PUT' and action is None) or (method == 'POST' and action in ['restore', 'archive']):
                    body = self.body()
                    if type(body.get('version')) is not int or body['version'] != row['version']:
                        raise APIError(409, '这项任务已被其他页面更新。你的草稿已保留，请查看最新版本后合并。', current=enrich_task(self.store.task(row), self.store.calendars(session['user_id'], db)))
                    archived = bool(row['archived'])
                    if action == 'restore':
                        old = db.execute('SELECT * FROM revisions WHERE project_id=? AND task_id=? AND version=?',
                                         (project_id, task_id, body.get('targetVersion'))).fetchone()
                        if not old:
                            raise APIError(404, '历史版本不存在')
                        task, archived = json.loads(old['data']), bool(old['archived'])
                        message = '恢复至版本 ' + str(old['version'])
                    elif action == 'archive':
                        task, archived = json.loads(row['data']), not archived
                        message = '归档任务' if archived else '取消归档'
                    else:
                        task = validate_task({**body, 'id': task_id})
                        message = '更新任务'
                    result = self.store.write(db, project_id, task, row['version'], message, archived)
                else:
                    raise APIError(405, '不支持的操作')
            return self.respond(200, {'task': enrich_task(result, self.store.calendars(session['user_id']))})
        raise APIError(404, '接口不存在')

    def rate_limit(self, scope, subject, limit=30, window=300):
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('DELETE FROM auth_attempts WHERE at<?', (time.time() - 3600,))
            count = db.execute('SELECT COUNT(*) FROM auth_attempts WHERE scope=? AND subject=? AND at>?',
                               (scope, subject, time.time() - window)).fetchone()[0]
            if count >= limit:
                raise APIError(429, '尝试次数过多，请稍后再试')
            db.execute('INSERT INTO auth_attempts VALUES(?,?,?)', (scope, subject, time.time()))

    def issue_session(self, db, user_id):
        token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        db.execute('DELETE FROM sessions WHERE expires<?', (time.time(),))
        db.execute('INSERT INTO sessions(token,csrf,expires,user_id) VALUES(?,?,?,?)',
                   (hashlib.sha256(token.encode()).hexdigest(), csrf, time.time() + 86400 * 7, user_id))
        return token, csrf

    def session_cookie(self, token):
        secure = '; Secure' if os.environ.get('BOARD_COOKIE_SECURE') == '1' else ''
        return 'board_session=' + token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800' + secure

    def login(self, body):
        self.rate_limit('login', self.client_address[0])
        username = validate_username(body.get('username'))
        password = body.get('password')
        if not isinstance(password, str) or len(password) > 128:
            raise APIError(400, '请填写账号和密码')
        with self.store.connect() as db:
            user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            # Missing accounts perform the same password work as existing accounts.
            dummy = '0' * 32 + ':' + '0' * 64
            verified = password_matches(password, user['password_hash'] if user else dummy)
            if not user or not verified:
                raise APIError(401, '账号或密码不正确')
            # Serialize with password changes so an old password cannot create a session after reset.
            db.execute('BEGIN IMMEDIATE')
            current = db.execute('SELECT * FROM users WHERE id=?', (user['id'],)).fetchone()
            if current['password_hash'] != user['password_hash']:
                raise APIError(401, '账号或密码已更新，请重新登录')
            token, csrf = self.issue_session(db, user['id'])
        self.respond(200, {'csrf': csrf, 'user': public_user(user)}, {'Set-Cookie': self.session_cookie(token)})

    def register(self, body):
        self.rate_limit('register', self.client_address[0], limit=20, window=3600)
        username = validate_username(body.get('username'))
        password = validate_password(body.get('password'))
        display_name = body.get('displayName', username)
        if not isinstance(display_name, str) or not 1 <= len(display_name.strip()) <= 40:
            raise APIError(400, '姓名或昵称需要 1 至 40 个字符')
        password_hash = hash_password(password)
        recovery = new_recovery_code()
        user_id = uuid.uuid4().hex
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT 1 FROM users WHERE username=?', (username,)).fetchone():
                raise APIError(409, '这个账号已被使用，请换一个账号')
            db.execute('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)',
                       (user_id, username, display_name.strip(), password_hash, hash_recovery_code(recovery), 'member', now(), now()))
            user = db.execute('SELECT * FROM users WHERE id=?', (user_id,)).fetchone()
        self.respond(201, {'user': public_user(user), 'recoveryCode': recovery})

    def reset_password(self, body):
        self.rate_limit('reset', self.client_address[0], limit=10)
        username = validate_username(body.get('username'))
        password = validate_password(body.get('newPassword'))
        code = body.get('recoveryCode')
        if not isinstance(code, str) or not 10 <= len(code) <= 100:
            raise APIError(400, '账号或密码恢复码不正确')
        code_hash, password_hash = hash_recovery_code(code), hash_password(password)
        new_code = new_recovery_code()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            user = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
            if not user or not hmac.compare_digest(user['recovery_hash'], code_hash):
                raise APIError(400, '账号或密码恢复码不正确')
            if password_matches(password, user['password_hash']):
                raise APIError(400, '新密码不能与当前密码相同')
            db.execute('UPDATE users SET password_hash=?, recovery_hash=?, updated_at=? WHERE id=?',
                       (password_hash, hash_recovery_code(new_code), now(), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
        self.respond(200, {'ok': True, 'username': username, 'recoveryCode': new_code})

    def change_password(self, session, body):
        self.rate_limit('change', session['user_id'], limit=10)
        password = validate_password(body.get('newPassword'))
        old_password = body.get('currentPassword')
        if not isinstance(old_password, str) or len(old_password) > 128:
            raise APIError(400, '请输入当前密码')
        password_hash = hash_password(password)
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            user = db.execute('SELECT * FROM users WHERE id=?', (session['user_id'],)).fetchone()
            if not password_matches(old_password, user['password_hash']):
                raise APIError(400, '当前密码不正确')
            if password_matches(password, user['password_hash']):
                raise APIError(400, '新密码不能与当前密码相同')
            db.execute('UPDATE users SET password_hash=?, updated_at=? WHERE id=?', (password_hash, now(), user['id']))
            db.execute('DELETE FROM sessions WHERE user_id=?', (user['id'],))
            token, csrf = self.issue_session(db, user['id'])
        self.respond(200, {'ok': True, 'csrf': csrf, 'user': public_user(user)}, {'Set-Cookie': self.session_cookie(token)})

    def import_preview(self, project_id, user_id, body):
        if body.get('kind') == 'file':
            name, encoded = body.get('name'), body.get('content')
            if not isinstance(name, str) or not 1 <= len(name) <= 240 or not isinstance(encoded, str):
                raise APIError(400, '请选择有效的本地文件')
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error):
                raise APIError(400, '文件上传内容无效')
            if len(raw) > MAX_FILE:
                raise APIError(413, '本地文件最大 2MB，请拆分文件后导入')
            data = parse_document(raw, name)
            data['source'] = Path(name).name
        elif body.get('kind') == 'link':
            auth = body.get('auth', {})
            if not isinstance(auth, dict):
                raise APIError(400, '授权信息格式无效')
            data = read_link(body.get('url'), auth)
        else:
            raise APIError(400, '请选择本地文件或文档链接')
        batch_id = uuid.uuid4().hex
        with self.store.connect() as db:
            versions = {row['id']: row['version'] for row in db.execute('SELECT id,version FROM tasks WHERE project_id=?', (project_id,))}
            used = set(versions)
            for index, row in enumerate(data['rows']):
                task = row['task']
                original = task.get('id', '')
                proposed = original
                if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', proposed) or proposed in used:
                    proposed = 'IM-'+batch_id[:8]+'-'+str(index+1).zfill(4)
                    if original:
                        row['warnings'].append('原编号重复、已存在或格式不兼容；新增时使用新编号，原编号为「'+original+'」')
                used.add(proposed)
                row['originalId'], row['appendId'] = original, proposed
                task['id'] = proposed
                row['errors'] = []
                try:
                    validate_task(task)
                except APIError as exc:
                    row['errors'].append(exc.message)
            data['createdAt'] = now()
            # Only parsed work records and sanitized provenance are persisted, never source credentials.
            db.execute('INSERT INTO import_batches(id,project_id,user_id,data,versions,created_at) VALUES(?,?,?,?,?,?)',
                       (batch_id, project_id, user_id, json.dumps(data, ensure_ascii=False), json.dumps(versions), now()))
        return self.respond(200, {**data, 'batchId': batch_id})

    def save_import(self, project_id, user_id, batch_id, body):
        values, mode = body.get('rows'), body.get('mode', 'append')
        if mode not in ['append', 'merge'] or not isinstance(values, list) or not 1 <= len(values) <= 2000:
            raise APIError(400, '请选择 1 至 2000 项工作记录以及正确的导入方式')
        request_hash = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        self.store.backup()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            batch = db.execute('SELECT * FROM import_batches WHERE id=? AND project_id=? AND user_id=?',
                               (batch_id, project_id, user_id)).fetchone()
            if not batch:
                raise APIError(404, '导入预览不存在，请重新读取文件')
            if batch['applied_at']:
                if batch['request_hash'] != request_hash:
                    raise APIError(409, '这批记录已保存。若需再次导入，请重新读取文件')
                return self.respond(200, json.loads(batch['result']))
            project = db.execute('SELECT archived FROM projects WHERE id=? AND owner_id=?', (project_id, user_id)).fetchone()
            if not project or project['archived']:
                raise APIError(409, '项目已归档或不存在，请先恢复项目')
            data, versions = json.loads(batch['data']), json.loads(batch['versions'])
            if mode == 'merge' and data.get('sourceProject') and data['sourceProject'] != project_id:
                raise APIError(400, '备份来自其他项目，只能新增导入；按编号更新请切换至原项目')
            existing = {r['id']: r for r in db.execute('SELECT * FROM tasks WHERE project_id=?', (project_id,))}
            tasks, seen, indices = [], set(), set()
            added, updated = 0, 0
            for value in values:
                if not isinstance(value, dict) or type(value.get('index')) is not int or not 0 <= value['index'] < len(data['rows']):
                    raise APIError(400, '预览行索引无效，请重新读取')
                if value['index'] in indices:
                    raise APIError(400, '重复提交预览行')
                indices.add(value['index'])
                raw = value.get('task')
                if not isinstance(raw, dict):
                    raise APIError(400, '工作项格式无效')
                task_id = raw.get('id')
                if not isinstance(task_id, str) or task_id in seen:
                    raise APIError(400, '工作编号为空或重复，请在预览中修正')
                seen.add(task_id)
                old = existing.get(task_id)
                if mode == 'append' and old:
                    raise APIError(409, '编号「'+task_id+'」已存在，请修改编号或选择按相同编号更新')
                if versions.get(task_id, 0) != (old['version'] if old else 0):
                    raise APIError(409, '编号「'+task_id+'」在预览后已被修改，请重新读取并核对后再保存')
                if old and old['archived']:
                    raise APIError(409, '编号「'+task_id+'」位于回收站，请先恢复，或改用新增编号')
                if old:
                    source = data['rows'][value['index']]
                    # Missing and empty spreadsheet cells never erase existing work records.
                    fields = set(source['fields']) | {key for key in raw if raw[key] != source['task'].get(key)}
                    merged = json.loads(old['data'])
                    merged.update({key: val for key, val in raw.items() if key in fields and val not in ['', None]})
                    raw = merged
                    updated += 1
                else:
                    added += 1
                try:
                    task = validate_task(raw)
                except APIError as exc:
                    raise APIError(400, '第 '+str(value['index']+1)+' 项：'+exc.message)
                tasks.append((task, old['version'] if old else 0))
            for task, version in tasks:
                self.store.write(db, project_id, task, version, '导入工作清单 · '+data['source'][:160])
            result = {'ok': True, 'count': len(tasks), 'added': added, 'updated': updated, 'batchId': batch_id}
            db.execute('UPDATE import_batches SET applied_at=?,request_hash=?,result=? WHERE id=?',
                       (now(), request_hash, json.dumps(result), batch_id))
        return self.respond(200, result)

    def import_tasks(self, project_id, body):
        values = body.get('tasks')
        if not isinstance(values, list) or not 1 <= len(values) <= 2000:
            raise APIError(400, '请选择包含任务的项目备份')
        tasks = [validate_task(task) for task in values]
        if len({t['id'] for t in tasks}) != len(tasks):
            raise APIError(400, '导入文件包含重复任务编号')
        expected = body.get('versions')
        if not isinstance(expected, dict):
            raise APIError(400, '缺少导入前的版本信息，请重新选择文件')
        # Backup before any bulk change. Existing tasks absent from the file are kept.
        self.store.backup()
        with self.store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            project = db.execute('SELECT archived FROM projects WHERE id=?', (project_id,)).fetchone()
            if project['archived']:
                raise APIError(409, '请先恢复项目')
            rows = {r['id']: r for r in db.execute('SELECT * FROM tasks WHERE project_id=?', (project_id,))}
            conflicts = [t['id'] for t in tasks if expected.get(t['id'], 0) != (rows[t['id']]['version'] if t['id'] in rows else 0)]
            if conflicts:
                raise APIError(409, '导入期间任务已发生变化，请刷新后重新导入', conflicts=conflicts)
            for task, raw in zip(tasks, values):
                old = rows.get(task['id'])
                archived = raw.get('archived') if type(raw.get('archived')) is bool else bool(old['archived']) if old else False
                self.store.write(db, project_id, task, old['version'] if old else 0, '导入填写记录', archived)
        self.respond(200, {'ok': True, 'count': len(tasks)})


def make_server(directory, host='127.0.0.1', port=8765):
    server = ThreadingHTTPServer((host, port), Handler)
    server.store = Store(directory)
    server.daemon_threads = False
    return server


def main():
    parser = argparse.ArgumentParser(description='海康 × 致趣项目空间')
    parser.add_argument('command', nargs='?', choices=['serve', 'backup', 'check'], default='serve')
    parser.add_argument('--host', default=os.environ.get('BOARD_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', '8765')))
    parser.add_argument('--data-dir', default=os.environ.get('BOARD_DATA_DIR', str(ROOT / 'data')))
    args = parser.parse_args()
    if args.command != 'serve':
        store = Store(args.data_dir)
        if args.command == 'backup':
            print('备份成功：' + str(store.backup()))
        else:
            with store.connect() as db:
                print('数据库完整性：' + db.execute('PRAGMA integrity_check').fetchone()[0])
        return
    server = make_server(args.data_dir, args.host, args.port)
    stop = threading.Event()
    def terminate(signum, frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, terminate)
    def periodic_backup():
        while not stop.wait(3600):
            try:
                server.store.backup()
            except Exception as exc:
                print('自动备份失败：' + str(exc), flush=True)
    threading.Thread(target=periodic_backup, daemon=True).start()
    print('项目空间已启动：http://' + args.host + ':' + str(server.server_port), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        server.server_close()
        server.store.backup()


if __name__ == '__main__':
    main()
