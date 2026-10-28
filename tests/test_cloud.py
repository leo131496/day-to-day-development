import importlib.util
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import cloud_store
import server
from scripts.migrate_turso import migrate
from tests.fake_turso import Provider
from tests import test_server as workspace

SDK = importlib.util.find_spec('turso_serverless') is not None


@unittest.skipUnless(SDK, 'Cloud driver is optional locally; installed by requirements-cloud.txt for deployment')
class CloudWorkspaceTest(workspace.WorkspaceTest):
    @classmethod
    def setUpClass(cls):
        import turso_serverless
        cls.cloud_temp=tempfile.TemporaryDirectory()
        cls.provider=Provider(Path(cls.cloud_temp.name)/'remote.sqlite3')
        def connection(factory):
            raw=turso_serverless.connect(cls.provider.base,auth_token='fixture-token')
            raw.row_factory=turso_serverless.Row
            return raw
        cls.patch_connection=patch.object(cloud_store.Factory,'_raw_connection',connection)
        cls.patch_environment=patch.dict(os.environ,{'BOARD_DATABASE_MODE':'turso','TURSO_DATABASE_URL':'turso://fixture.turso.io','TURSO_AUTH_TOKEN':'fixture-token'})
        cls.patch_connection.start();cls.patch_environment.start()
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        cls.patch_environment.stop();cls.patch_connection.stop()
        cls.provider.close();cls.cloud_temp.cleanup()

    def test_persistence_backup_restart_initialization(self):
        project,_=self.create()
        base='/api/projects/'+project['id']
        task=self.request(base)[1]['tasks'][0]
        task['evidence']='https://example.com/cloud-delivery'
        self.assertEqual(self.request(base+'/tasks/'+task['id'],'PUT',task)[0],200)
        # A completely new ephemeral cache must reconnect to the existing durable data.
        with tempfile.TemporaryDirectory() as cache:
            reopened=server.TursoStore(cache)
            self.assertFalse(reopened.path.exists(),'Cloud mode must never create a local business database')
            self.assertEqual(reopened.snapshot(project['id'])['tasks'][0]['evidence'],task['evidence'])
            file=reopened.backup()
            with sqlite3.connect(file) as db:
                self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok')
                self.assertEqual(db.execute('SELECT COUNT(*) FROM revisions WHERE project_id=?',(project['id'],)).fetchone()[0],4)
            with reopened.connect() as db:
                identifier=db.execute('SELECT id FROM cloud_backups ORDER BY created_at DESC LIMIT 1').fetchone()[0]
            file.unlink()
            restored=cloud_store.restore_archive(reopened,identifier,Path(cache)/'restored.sqlite3')
            with sqlite3.connect(restored) as db, self.http.store.connect() as live:
                self.assertEqual(db.execute('SELECT data FROM tasks WHERE project_id=? AND id=?',(project['id'],task['id'])).fetchone()[0],
                                 live.execute('SELECT data FROM tasks WHERE project_id=? AND id=?',(project['id'],task['id'])).fetchone()[0])

    def test_cloud_import_preview_retry_and_archive_limits(self):
        import base64
        project,_=self.create();base='/api/projects/'+project['id']
        code,preview=self.request(base+'/import-preview','POST',{'kind':'file','name':'work.csv',
            'content':base64.b64encode('编号,任务名称,负责人\nCLOUD-IMPORT,云端导入,张三'.encode()).decode()})
        self.assertEqual(code,200,preview)
        body={'mode':'append','rows':[{'index':0,'task':preview['rows'][0]['task']}]}
        endpoint=base+'/import-batches/'+preview['batchId']+'/save'
        self.assertEqual(self.request(endpoint,'POST',body)[0],200)
        self.assertEqual(self.request(endpoint,'POST',body)[0],200)
        self.assertEqual(len(self.request(base)[1]['tasks']),4)
        with self.http.store.connect() as db:
            self.assertLessEqual(db.execute('SELECT COUNT(*) FROM cloud_backups').fetchone()[0],8)

    def test_failed_cloud_connection_never_falls_back_to_local_data(self):
        with tempfile.TemporaryDirectory() as cache, patch.object(cloud_store.Factory,'_raw_connection',side_effect=cloud_store.CloudDatabaseError('offline')):
            with self.assertRaises(cloud_store.CloudDatabaseError): server.TursoStore(cache)
            self.assertFalse((Path(cache)/'project.sqlite3').exists())


class CloudConfigurationTest(unittest.TestCase):
    def test_free_configuration_and_missing_credentials_abort(self):
        with patch.dict(os.environ,{'BOARD_DATABASE_MODE':'turso'},clear=True),tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(cloud_store.CloudDatabaseError): server.make_store(directory)
            self.assertFalse((Path(directory)/'project.sqlite3').exists())
        for value in ['https://example.com','https://user:secret@a.turso.io','http://a.turso.io','https://a.turso.io?token=secret']:
            with self.subTest(value=value),self.assertRaises(cloud_store.CloudDatabaseError): cloud_store.database_url(value)
        self.assertEqual(cloud_store.database_url('turso://workspace.turso.io'),'https://workspace.turso.io')

    def test_cloud_migration_is_atomic_and_requires_empty_target(self):
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'BOARD_PASSWORD':'cloud-migration-test-2026'}):
            root=Path(directory);source=server.Store(root/'source');remote=root/'target.sqlite3'
            class Factory:
                def connect(self):
                    connection=sqlite3.connect(remote);connection.row_factory=sqlite3.Row
                    return connection
            counts=migrate(source.path,Factory())
            self.assertEqual(counts['tasks'],50);self.assertEqual(counts['revisions'],50)
            with self.assertRaises(cloud_store.CloudDatabaseError): migrate(source.path,Factory())
            with sqlite3.connect(remote) as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM tasks').fetchone()[0],50)
