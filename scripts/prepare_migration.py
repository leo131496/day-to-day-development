"""Create a private, consistent SQLite migration file without touching live records."""
import argparse
import json
import os
from pathlib import Path
import sqlite3


def prepare(source, destination):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if not source.is_file() or source == destination:
        raise ValueError('源数据库不存在或迁移目标与源文件相同')
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Never overwrite an earlier migration or a running database.
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with sqlite3.connect(source.as_uri()+'?mode=ro', uri=True) as live, sqlite3.connect(destination) as copy:
            live.backup(copy)
            if copy.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
                raise ValueError('迁移文件完整性检查失败')
            # A new deployment must ask all devices to log in again.
            copy.execute('DELETE FROM sessions')
            copy.execute('DELETE FROM auth_attempts')
            copy.commit()
            copy.execute('PRAGMA journal_mode=DELETE')
            tables = ['projects', 'tasks', 'revisions', 'users', 'work_calendars', 'calendar_revisions', 'import_batches']
            counts = {table: copy.execute('SELECT COUNT(*) FROM '+table).fetchone()[0] for table in tables}
        destination.chmod(0o600)
        return counts
    except Exception:
        destination.unlink(missing_ok=True)
        raise


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description='准备完整云端迁移文件，文件含私密数据，不要上传 GitHub')
    parser.add_argument('--source', default=str(root/'data/project.sqlite3'))
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    counts = prepare(args.source, args.output)
    print('迁移文件已生成并通过校验（请使用私密通道传到云服务器）：'+str(Path(args.output).resolve()))
    print(json.dumps(counts, ensure_ascii=False))
