"""Direct Turso storage for hosts with ephemeral disks. Never falls back to local writes."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
import uuid
import zlib


class CloudDatabaseError(RuntimeError):
    pass


APP_TABLES = ('meta','projects','tasks','revisions','sessions','users','auth_attempts',
              'work_calendars','calendar_revisions','import_batches')


def database_url(value):
    try:
        parts = urlsplit(value)
        if (parts.scheme not in ['https', 'libsql', 'turso'] or not parts.hostname
                or not parts.hostname.endswith('.turso.io') or parts.port not in [None, 443]
                or parts.username or parts.password or parts.query or parts.fragment or parts.path not in ['', '/']):
            raise ValueError()
        return 'https://'+parts.netloc
    except (TypeError, ValueError):
        raise CloudDatabaseError('请配置有效的 TURSO_DATABASE_URL（Turso 官方数据库地址）') from None


class Factory:
    def __init__(self, url=None, token=None):
        self.url = database_url(url if url is not None else os.environ.get('TURSO_DATABASE_URL', ''))
        self.token = token if token is not None else os.environ.get('TURSO_AUTH_TOKEN', '')
        if not isinstance(self.token, str) or not self.token or len(self.token) > 16384 or any(c in self.token for c in '\r\n\x00'):
            raise CloudDatabaseError('请在云平台配置 TURSO_AUTH_TOKEN，不要将令牌写进 GitHub')

    def _raw_connection(self):
        try:
            import turso_serverless
            from turso_serverless.session import Session
            from turso_serverless.protocol import ProtocolError
        except ImportError:
            raise CloudDatabaseError('云端数据库需要 Python 3.10+ 并安装 requirements-cloud.txt') from None

        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        class BoundedSession(Session):
            def _post(self, path, body):
                # Verify every server-selected endpoint; credentials stay on official HTTPS hosts.
                base = database_url(self._base_url)
                request = urllib.request.Request(base+path, data=json.dumps(body, allow_nan=False).encode(),
                                                 headers=self._headers(), method='POST')
                try:
                    with urllib.request.build_opener(NoRedirect()).open(request, timeout=25) as response:
                        raw = response.read(64_000_001)
                        if len(raw) > 64_000_000:
                            raise ValueError('response too large')
                        return raw
                except Exception:
                    self._reset_stream()
                    raise ProtocolError('云数据库连接失败、配额不足或读取超时，请稍后重试；未切换到本机存储') from None

        connection = turso_serverless.Connection(BoundedSession(self.url, auth_token=self.token))
        connection.row_factory = turso_serverless.Row
        return connection

    def connect(self):
        connection = Connection(self._raw_connection())
        try:
            connection.execute('PRAGMA foreign_keys=ON')
            return connection
        except Exception:
            connection.raw.close()
            raise


class Connection:
    def __init__(self, raw):
        self.raw = raw

    def __enter__(self):
        return self

    def __exit__(self, kind, value, traceback):
        try:
            if kind is None:
                self.commit()
            else:
                try:
                    self.raw.rollback()
                except Exception:
                    pass  # Preserve the original failure after a broken stream.
        finally:
            self.raw.close()
        return False

    def execute(self, sql, parameters=()):
        try:
            return self.raw.execute(sql, parameters)
        except Exception:
            raise CloudDatabaseError('云数据库操作失败，请检查连接、令牌权限和免费配额；填写草稿会保留') from None

    def executescript(self, sql):
        try:
            return self.raw.executescript(sql)
        except Exception:
            raise CloudDatabaseError('云数据库初始化失败，请检查数据库权限与连接') from None

    def commit(self):
        try:
            self.raw.commit()
        except Exception:
            raise CloudDatabaseError('云数据库提交结果未能确认，请保留草稿并重试；导入可安全重试') from None


def copy_to_sqlite(source, destination):
    """Consistent read transaction; excludes backup archives to avoid recursive snapshots."""
    source.execute('BEGIN')
    schema = source.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL "
                            "AND name NOT LIKE 'sqlite_%' AND tbl_name IN ("+','.join('?' for _ in APP_TABLES)+") "
                            "AND type IN ('table','index') ORDER BY type DESC,name", APP_TABLES).fetchall()
    destination.execute('PRAGMA foreign_keys=OFF')
    for item in schema:
        if item['type'] == 'table':
            destination.execute(item['sql'])
    for item in schema:
        if item['type'] != 'table':
            continue
        quoted = '"'+item['name'].replace('"', '""')+'"'
        result = source.execute('SELECT * FROM '+quoted)
        placeholders = ','.join('?' for _ in result.description)
        for row in result:
            destination.execute('INSERT INTO '+quoted+' VALUES('+placeholders+')', tuple(row))
    for item in schema:
        if item['type'] == 'index':
            destination.execute(item['sql'])
    destination.commit()
    if destination.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise CloudDatabaseError('云数据库备份完整性检查失败')
    if destination.execute('PRAGMA foreign_key_check').fetchone():
        raise CloudDatabaseError('云数据库备份的关联记录校验失败')


def archive_backup(store, temporary, stamp):
    raw = temporary.read_bytes()
    checksum = hashlib.sha256(raw).hexdigest()
    compressed = zlib.compress(raw, level=6)
    pieces = [compressed[i:i+64000] for i in range(0, len(compressed), 64000)]
    if len(raw) > 256_000_000:
        raise CloudDatabaseError('全量备份超过当前轻量方案限制，请先导出并安排数据库扩容')
    with store.connect() as db:
        db.executescript('''CREATE TABLE IF NOT EXISTS cloud_backups(
            id TEXT PRIMARY KEY, created_at TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE,
            original_bytes INTEGER NOT NULL, chunks INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS cloud_backup_chunks(
            backup_id TEXT NOT NULL REFERENCES cloud_backups(id), part INTEGER NOT NULL,
            data BLOB NOT NULL, PRIMARY KEY(backup_id,part));''')
        db.execute('BEGIN IMMEDIATE')
        if not db.execute('SELECT id FROM cloud_backups WHERE checksum=?', (checksum,)).fetchone():
            identifier = uuid.uuid4().hex
            db.execute('INSERT INTO cloud_backups VALUES(?,?,?,?,?)', (identifier, stamp, checksum, len(raw), len(pieces)))
            for index, piece in enumerate(pieces):
                db.execute('INSERT INTO cloud_backup_chunks VALUES(?,?,?)', (identifier, index, piece))
        # The latest eight full snapshots persist independently of the web host's cache.
        obsolete = db.execute('SELECT id FROM cloud_backups ORDER BY created_at DESC,id DESC').fetchall()[8:]
        for row in obsolete:
            db.execute('DELETE FROM cloud_backup_chunks WHERE backup_id=?', (row['id'],))
            db.execute('DELETE FROM cloud_backups WHERE id=?', (row['id'],))


def backup(store, stamp):
    with store.backup_lock:
        target = store.backup_dir / ('cloud-'+uuid.uuid4().hex+'.sqlite3')
        temporary = target.with_suffix('.tmp')
        try:
            with store.connect() as source, sqlite3.connect(temporary) as destination:
                copy_to_sqlite(source, destination)
            temporary.chmod(0o600)
            archive_backup(store, temporary, stamp)
            temporary.replace(target)
            store.backup_error, store.last_backup = None, stamp
            for old in store.backup_dir.glob('cloud-*.sqlite3'):
                if old != target and old.stat().st_mtime < time.time()-300:
                    old.unlink()
            return target
        except Exception:
            temporary.unlink(missing_ok=True)
            store.backup_error = '云端备份未完成，请检查数据库连接与免费配额，并及时导出备份'
            raise CloudDatabaseError(store.backup_error) from None


def restore_archive(store, identifier, target):
    """Download a cloud snapshot for private, offline restoration; never overwrites live data."""
    target = Path(target)
    descriptor = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with store.connect() as db:
            db.execute('BEGIN')
            info = db.execute('SELECT * FROM cloud_backups WHERE id=?', (identifier,)).fetchone()
            if not info or not 0 < info['original_bytes'] <= 256_000_000:
                raise CloudDatabaseError('备份不存在或大小无效')
            chunks = db.execute('SELECT part,data FROM cloud_backup_chunks WHERE backup_id=? ORDER BY part', (identifier,)).fetchall()
        if len(chunks) != info['chunks'] or [r['part'] for r in chunks] != list(range(info['chunks'])):
            raise CloudDatabaseError('备份分块不完整')
        decoder = zlib.decompressobj()
        raw = decoder.decompress(b''.join(r['data'] for r in chunks), info['original_bytes']+1)
        if not decoder.eof or len(raw) != info['original_bytes'] or hashlib.sha256(raw).hexdigest() != info['checksum']:
            raise CloudDatabaseError('备份校验失败')
        target.write_bytes(raw)
        with sqlite3.connect(target) as db:
            if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise CloudDatabaseError('备份数据库损坏')
        return target
    except Exception:
        target.unlink(missing_ok=True)
        raise
