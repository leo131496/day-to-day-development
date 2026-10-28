"""Project risk register, with version checks and recoverable deletion."""
import datetime as dt
import json
import re

SCHEMA = '''
CREATE TABLE IF NOT EXISTS risks(
    project_id TEXT NOT NULL REFERENCES projects(id), id TEXT NOT NULL, data TEXT NOT NULL,
    version INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
    PRIMARY KEY(project_id,id));
CREATE TABLE IF NOT EXISTS risk_revisions(
    project_id TEXT NOT NULL, risk_id TEXT NOT NULL, version INTEGER NOT NULL,
    data TEXT NOT NULL, archived INTEGER NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(project_id,risk_id,version),
    FOREIGN KEY(project_id,risk_id) REFERENCES risks(project_id,id));
'''
STATUSES = ['已识别', '处理中', '待验证', '已关闭']
CATEGORIES = ['范围与需求', '进度与交付', '资源与人员', '技术与质量', '客户与协作', '成本与合同', '安全与合规', '其他']


def validate(value, error):
    if not isinstance(value, dict):
        raise error(400, '风险记录格式无效')
    result = {}
    for key in ['id', 'title', 'description', 'category', 'owner', 'status', 'response',
                'resolution', 'identifiedAt', 'due', 'closedAt', 'linkedTaskId']:
        text = value.get(key, '')
        limit = 30000 if key in ['description', 'response', 'resolution'] else 2000
        if not isinstance(text, str) or len(text) > limit:
            raise error(400, '风险字段格式或长度无效：'+key)
        result[key] = text.strip()
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', result['id']):
        raise error(400, '风险编号格式无效')
    if not 1 <= len(result['title']) <= 160 or not result['description']:
        raise error(400, '请填写风险名称（最多 160 字）及风险描述')
    if result['status'] not in STATUSES or result['category'] not in CATEGORIES:
        raise error(400, '风险状态或类别无效')
    for key in ['probability', 'impact']:
        number = value.get(key)
        if type(number) is not int or number not in [1, 2, 3]:
            raise error(400, '请选择风险发生概率和影响程度')
        result[key] = number
    for key in ['identifiedAt', 'due', 'closedAt']:
        try:
            if result[key] and dt.date.fromisoformat(result[key]).isoformat() != result[key]:
                raise ValueError()
        except ValueError:
            raise error(400, '风险日期格式无效：'+key)
    if not result['identifiedAt']:
        raise error(400, '请填写风险识别日期')
    if result['due'] and result['due'] < result['identifiedAt']:
        raise error(400, '风险截止日期不能早于识别日期')
    if result['status'] == '已关闭':
        if not result['resolution'] or not result['closedAt']:
            raise error(400, '关闭风险前，请填写处理结果和关闭日期')
        if result['closedAt'] < result['identifiedAt']:
            raise error(400, '关闭日期不能早于识别日期')
    else:
        result['closedAt'] = ''
    return result


def write(db, project_id, risk, previous, action, stamp, archived=False):
    raw, version = json.dumps(risk, ensure_ascii=False), previous+1
    db.execute('INSERT INTO risks VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET '
               'data=excluded.data,version=excluded.version,archived=excluded.archived,updated_at=excluded.updated_at',
               (project_id, risk['id'], raw, version, int(archived), stamp))
    db.execute('INSERT INTO risk_revisions VALUES(?,?,?,?,?,?,?)',
               (project_id, risk['id'], version, raw, int(archived), action, stamp))
    return {**risk, 'version': version, 'archived': bool(archived), 'updatedAt': stamp}


def route(handler, project_id, path, method, error, stamp):
    match = re.fullmatch(r'/api/risks(?:/([A-Za-z0-9_.-]+)(?:/(archive|history))?)?', path)
    if not match:
        raise error(404, '风险接口不存在')
    risk_id, action = match.groups()
    body = handler.body() if method != 'GET' else {}
    with handler.store.connect() as db:
        db.execute('BEGIN IMMEDIATE' if method != 'GET' else 'BEGIN')
        if method != 'GET' and db.execute('SELECT archived FROM projects WHERE id=?', (project_id,)).fetchone()['archived']:
            raise error(409, '请先恢复项目再编辑风险')
        if not risk_id and method == 'GET':
            return handler.respond(200, {'risks': [handler.store.task(r) for r in
                db.execute('SELECT * FROM risks WHERE project_id=? ORDER BY updated_at DESC,id', (project_id,))]})
        if not risk_id and method == 'POST':
            risk = validate(body, error)
            old = db.execute('SELECT * FROM risks WHERE project_id=? AND id=?', (project_id, risk['id'])).fetchone()
            if old:
                if not old['archived'] and json.loads(old['data']) == risk:
                    return handler.respond(200, {'risk': handler.store.task(old)})
                raise error(409, '风险编号已存在，请重新读取后编辑', current=handler.store.task(old))
        else:
            old = db.execute('SELECT * FROM risks WHERE project_id=? AND id=?', (project_id, risk_id)).fetchone()
            if not old:
                raise error(404, '风险记录不存在')
            if action == 'history' and method == 'GET':
                history = [{'version': r['version'], 'risk': json.loads(r['data']), 'archived': bool(r['archived']),
                            'action': r['action'], 'at': r['created_at']} for r in db.execute(
                    'SELECT * FROM risk_revisions WHERE project_id=? AND risk_id=? ORDER BY version DESC', (project_id, risk_id))]
                return handler.respond(200, {'history': history})
            if not (method == 'PUT' and not action or method == 'POST' and action == 'archive'):
                raise error(405, '不支持的风险操作')
            if type(body.get('version')) is not int or body['version'] != old['version']:
                raise error(409, '风险记录已被其他页面修改，当前填写已保留，请核对最新版本后再保存', current=handler.store.task(old))
            if action == 'archive':
                if type(body.get('archived')) is not bool:
                    raise error(400, '请选择删除或恢复风险')
                risk = json.loads(old['data'])
            else:
                if old['archived']:
                    raise error(409, '请先从风险回收站恢复记录')
                risk = validate({**body, 'id': risk_id}, error)
        if risk['linkedTaskId'] and not db.execute('SELECT 1 FROM tasks WHERE project_id=? AND id=?', (project_id, risk['linkedTaskId'])).fetchone():
            raise error(400, '关联工作项不存在于当前项目，请重新选择')
        archived = body['archived'] if action == 'archive' else False
        result = write(db, project_id, risk, old['version'] if old else 0,
                       '删除风险' if archived else '恢复风险' if action else '更新风险' if old else '新增风险', stamp(), archived)
    return handler.respond(201 if not old else 200, {'risk': result})
