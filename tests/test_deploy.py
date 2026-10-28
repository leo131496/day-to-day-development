import io
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import server
from scripts.configure_public_url import configure, validate_url
from scripts.prepare_migration import prepare


class DeploymentTest(unittest.TestCase):
    def test_render_https_origin_and_explicit_domain_override(self):
        handler = object.__new__(server.Handler)
        handler.headers = {'Origin':'https://project-space.onrender.com','Host':'project-space.onrender.com',
                           'X-Requested-With':'ProjectBoard'}
        with patch.dict(os.environ, {'RENDER_EXTERNAL_URL':'https://project-space.onrender.com'}, clear=True):
            handler.check_origin()
            handler.headers['Origin'] = 'https://other.example.com'
            with self.assertRaises(server.APIError):
                handler.check_origin()
        handler.headers['Origin'] = 'https://projects.example.com'
        with patch.dict(os.environ, {'RENDER_EXTERNAL_URL':'https://project-space.onrender.com','BOARD_ORIGIN':'https://projects.example.com'}, clear=True):
            handler.check_origin()
            handler.headers['Origin'] = 'https://project-space.onrender.com'
            with self.assertRaises(server.APIError):
                handler.check_origin()

    def test_portal_url_only_updates_after_api_health_succeeds(self):
        for value in ['http://example.com','https://user:secret@example.com','https://example.com/app','https://example.com?token=secret','https://localhost']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                validate_url(value)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'docs').mkdir()
            config = root/'docs/config.json'
            config.write_text('{"appUrl":""}')
            response = io.BytesIO(b'{"ok":false}')
            response.status = 200
            with patch('scripts.configure_public_url.urllib.request.urlopen', return_value=response), self.assertRaises(ValueError):
                configure('https://projects.example.com',root)
            self.assertEqual(json.loads(config.read_text())['appUrl'],'')
            response = io.BytesIO(b'{"ok":true}')
            response.status = 200
            with patch('scripts.configure_public_url.urllib.request.urlopen', return_value=response):
                self.assertEqual(configure('https://projects.example.com/',root),'https://projects.example.com')
            self.assertEqual(json.loads(config.read_text())['appUrl'],'https://projects.example.com')

    def test_private_migration_preserves_records_without_changing_live_db(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'BOARD_PASSWORD':'deployment-test-password-2026'}):
            root = Path(directory)
            store = server.Store(root/'live')
            with store.connect() as db:
                db.execute('INSERT INTO sessions(token,csrf,expires,user_id) VALUES(?,?,?,?)',
                           ('test-hash','csrf',9999999999,'admin'))
            # Source sessions and business records remain intact; the migration copy revokes sessions.
            destination = root/'migration/project.sqlite3'
            counts = prepare(store.path, destination)
            self.assertEqual(counts['tasks'],50)
            self.assertEqual(counts['revisions'],50)
            with sqlite3.connect(destination) as migrated, store.connect() as live:
                self.assertEqual(migrated.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                self.assertEqual(migrated.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)
                self.assertEqual(live.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],1)
                for table in ['projects','tasks','revisions','users','work_calendars','calendar_revisions','import_batches']:
                    self.assertEqual(migrated.execute('SELECT * FROM '+table).fetchall(), [tuple(row) for row in live.execute('SELECT * FROM '+table)])
            self.assertEqual(destination.stat().st_mode & 0o777,0o600)
            with self.assertRaises(FileExistsError):
                prepare(store.path,destination)
