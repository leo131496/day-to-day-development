"""Upload a private SQLite backup into an EMPTY Turso database, in one transaction."""
import argparse
import os
from pathlib import Path
import sqlite3
import sys

if __name__ == '__main__':
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from cloud_store import Factory, CloudDatabaseError


def migrate(source, factory=None):
    source = Path(source).resolve()
    if not source.is_file():
        raise ValueError('本机迁移备份不存在')
    factory = factory or Factory()
    with sqlite3.connect(source.as_uri()+'?mode=ro', uri=True) as local, factory.connect() as remote:
        local.row_factory = sqlite3.Row
        if local.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('本机迁移备份校验失败')
        schema = local.execute("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL "
                               "AND name NOT LIKE 'sqlite_%' AND type IN ('table','index') "
                               "AND name NOT IN ('cloud_backups','cloud_backup_chunks') ORDER BY type DESC,name").fetchall()
        tables = {r['name'] for r in schema if r['type'] == 'table'}
        if not {'users','projects','tasks','revisions','meta'} <= tables:
            raise ValueError('不是完整的项目工作台数据库')
        remote.execute('BEGIN IMMEDIATE')
        if remote.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchone():
            raise CloudDatabaseError('云数据库不是空库，迁移已停止，不会覆盖任何已有数据；请创建新的空数据库')
        for item in schema:
            if item['type'] == 'table':
                remote.execute(item['sql'])
        order = {'users':0,'projects':1,'tasks':2,'revisions':3,'work_calendars':4,'calendar_revisions':5,'import_batches':6,'risks':7,'risk_revisions':8}
        counts = {}
        for name in sorted(tables, key=lambda n:(order.get(n, 10), n)):
            quoted = '"'+name.replace('"', '""')+'"'
            rows = [] if name in ['sessions','auth_attempts'] else local.execute('SELECT * FROM '+quoted).fetchall()
            for row in rows:
                remote.execute('INSERT INTO '+quoted+' VALUES('+','.join('?' for _ in row)+')', tuple(row))
            actual = remote.execute('SELECT COUNT(*) FROM '+quoted).fetchone()[0]
            if actual != len(rows):
                raise CloudDatabaseError('迁移数量校验失败，整批迁移已回滚')
            counts[name] = actual
        for item in schema:
            if item['type'] == 'index':
                remote.execute(item['sql'])
        # The cloud app sees initialized metadata and never seeds over migrated records.
        if remote.execute('PRAGMA foreign_key_check').fetchone():
            raise CloudDatabaseError('迁移关联记录校验失败，整批迁移已回滚')
    return counts


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='将本机完整备份迁移至空 Turso 数据库；令牌从环境变量读取')
    parser.add_argument('--source', required=True)
    args = parser.parse_args()
    try:
        print('迁移已提交：'+str(migrate(args.source)))
    except Exception:
        raise SystemExit('迁移未完成：检查私密备份、空数据库及云端环境变量；没有覆盖已有数据库。') from None
