import concurrent.futures
import http.cookiejar
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import server


class WorkspaceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        os.environ['BOARD_PASSWORD'] = 'test-password-very-long-2026'
        cls.http = server.make_server(cls.temp.name, port=0)
        cls.base = 'http://127.0.0.1:' + str(cls.http.server_port)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.temp.cleanup()

    def setUp(self):
        self.client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = ''
        code, data = self.request('/api/login', 'POST', {'username': 'admin', 'password': os.environ['BOARD_PASSWORD']})
        self.assertEqual(code, 200)
        self.csrf = data['csrf']

    def request(self, path, method='GET', body=None, headers=None):
        req = urllib.request.Request(self.base + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json', 'X-Requested-With': 'ProjectBoard',
                     'X-CSRF-Token': self.csrf, 'Origin': self.base, **(headers or {})})
        try:
            with self.client.open(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def create(self, content='需求阶段：\n1. 用户访谈，负责人：张三，截止：2026-11-03\n2. 输出方案，交付物：确认版方案\n交付阶段：\n3. 联调测试'):
        code, generated = self.request('/api/generate', 'POST', {'content': content})
        self.assertEqual(code, 200)
        code, result = self.request('/api/projects', 'POST', {'name': '测试项目', 'content': content, 'tasks': generated['tasks']})
        self.assertEqual(code, 201, result)
        return result['project'], generated['tasks']

    def test_seed_and_generation(self):
        code, data = self.request('/api/projects/haikang')
        self.assertEqual(code, 200)
        self.assertEqual(len(data['tasks']), 50)
        self.assertIn('系统调研', [t['title'] for t in data['tasks']])
        project, tasks = self.create()
        self.assertEqual(len(tasks), 3)
        self.assertEqual(tasks[0]['owner'], '张三')
        self.assertEqual(tasks[0]['end'], '2026-11-03')
        self.assertEqual(tasks[1]['criteria'], '确认版方案')
        self.assertEqual(tasks[2]['stage'], '交付阶段')
        self.assertEqual(tasks[2]['end'], '')

    def test_full_database_backup_requires_admin(self):
        with self.client.open(self.base+'/api/admin/database-backup') as response:
            self.assertEqual(response.read(16), b'SQLite format 3\x00')
        code,_=self.request('/api/register','POST',{'username':'backup.member','displayName':'备份权限成员',
                                                  'password':'backup-member-password-2026'})
        self.assertEqual(code,201)
        _,login=self.request('/api/login','POST',{'username':'backup.member','password':'backup-member-password-2026'})
        self.csrf=login['csrf']
        self.assertEqual(self.request('/api/admin/database-backup')[0],403)

    def test_crud_conflict_restore_and_isolation(self):
        project, tasks = self.create()
        other, _ = self.create()
        base = '/api/projects/' + project['id']
        _, snapshot = self.request(base)
        task = snapshot['tasks'][0]
        task['nextAction'] = '已完成首次沟通，等待确认'
        code, saved = self.request(base+'/tasks/'+task['id'], 'PUT', task)
        self.assertEqual(code, 200)
        self.assertEqual(saved['task']['version'], 2)
        code, conflict = self.request(base+'/tasks/'+task['id'], 'PUT', task)
        self.assertEqual(code, 409)
        self.assertEqual(conflict['current']['nextAction'], task['nextAction'])
        _, isolated = self.request('/api/projects/'+other['id'])
        self.assertNotEqual(isolated['tasks'][0]['nextAction'], task['nextAction'])
        code, archived = self.request(base+'/tasks/'+task['id']+'/archive', 'POST', {'version':2})
        self.assertEqual(code, 200)
        self.assertTrue(archived['task']['archived'])
        code, restored = self.request(base+'/tasks/'+task['id']+'/restore', 'POST', {'version':3,'targetVersion':1})
        self.assertEqual(code, 200)
        self.assertFalse(restored['task']['archived'])
        self.assertEqual(restored['task']['version'], 4)
        _, history = self.request(base+'/tasks/'+task['id']+'/history')
        self.assertEqual(len(history['history']), 4)
        code, _ = self.request(base+'/archive', 'POST', {'version':1})
        self.assertEqual(code, 200)
        code, _ = self.request(base+'/tasks/'+task['id'], 'PUT', restored['task'])
        self.assertEqual(code, 409)
        code, _ = self.request(base+'/archive', 'POST', {'version':2})
        self.assertEqual(code, 200)
        code, exported = self.request(base+'/export')
        self.assertEqual(code, 200)
        self.assertEqual(len(exported['tasks']), 3)

    def test_import_is_atomic_and_non_destructive(self):
        project, _ = self.create()
        base = '/api/projects/'+project['id']
        _, data = self.request(base)
        task = data['tasks'][0]
        task['owner'] = '新负责人'
        payload = {'tasks':[task], 'versions':{task['id']:0}}
        self.assertEqual(self.request(base+'/import','POST',payload)[0], 409)
        payload['versions'][task['id']] = task['version']
        self.assertEqual(self.request(base+'/import','POST',payload)[0], 200)
        _, after = self.request(base)
        self.assertEqual(len(after['tasks']), 3)
        self.assertEqual(after['tasks'][0]['owner'], '新负责人')
        self.assertEqual(self.request(base+'/import','POST',{'tasks':[task,{'id':'invalid'}], 'versions':{task['id']:2}})[0],400)
        _, after_invalid = self.request(base)
        self.assertEqual(after_invalid['tasks'][0]['version'],2)

    def test_persistence_backup_restart_initialization(self):
        project, _ = self.create()
        base = '/api/projects/'+project['id']
        _, data = self.request(base)
        task = data['tasks'][0]
        task['evidence'] = 'https://example.com/交付文档?v=2'
        self.assertEqual(self.request(base+'/tasks/'+task['id'],'PUT',task)[0],200)
        # Reopening the database must not seed over existing edits.
        reopened = server.Store(self.temp.name)
        snapshot = reopened.snapshot(project['id'])
        self.assertEqual(snapshot['tasks'][0]['evidence'],task['evidence'])
        file = reopened.backup()
        with sqlite3.connect(str(file)) as backup:
            self.assertEqual(backup.execute('PRAGMA integrity_check').fetchone()[0],'ok')
            raw = backup.execute('SELECT data FROM tasks WHERE project_id=? AND id=?',(project['id'],task['id'])).fetchone()[0]
            self.assertEqual(json.loads(raw)['evidence'],task['evidence'])
            self.assertEqual(backup.execute('SELECT COUNT(*) FROM revisions WHERE project_id=? AND task_id=?',(project['id'],task['id'])).fetchone()[0],2)

    def test_parallel_updates_one_winner(self):
        project, _ = self.create()
        base = '/api/projects/'+project['id']
        _, data = self.request(base)
        task = data['tasks'][0]
        def update(index):
            return self.request(base+'/tasks/'+task['id'],'PUT',{**task,'owner':'成员'+str(index)})[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            result = list(executor.map(update, [1,2]))
        self.assertEqual(sorted(result),[200,409])

    def test_security_validation_and_task_creation(self):
        project, tasks = self.create()
        base = '/api/projects/'+project['id']
        new = {**tasks[0], 'id':'CUSTOM-1', 'title':'手动任务'}
        self.assertEqual(self.request(base+'/tasks','POST',new)[0],201)
        self.assertEqual(self.request(base+'/tasks','POST',new)[0],409)
        self.assertEqual(self.request(base+'/tasks','POST',{**new,'id':'BAD','progress':2})[0],400)
        self.assertEqual(self.request(base+'/tasks','POST',{**new,'id':'BAD','status':'已完成','progress':0})[0],400)
        self.assertEqual(self.request(base+'/tasks','POST',new,{'Origin':'https://malicious.example'})[0],403)
        self.assertEqual(self.request(base+'/tasks','POST',new,{'X-CSRF-Token':'wrong'})[0],403)
        self.request('/api/logout','POST',{})
        self.assertEqual(self.request(base)[0],401)


if __name__ == '__main__':
    unittest.main(verbosity=2)
