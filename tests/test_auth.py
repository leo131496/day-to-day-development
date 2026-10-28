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


class AccountTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        os.environ['BOARD_PASSWORD'] = 'initial-admin-password-2026'
        self.http = server.make_server(self.temp.name, port=0)
        self.base = 'http://127.0.0.1:' + str(self.http.server_port)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.client = self.new_client()
        self.password = 'account-password-2026'

    def tearDown(self):
        self.http.shutdown()
        self.http.server_close()
        self.temp.cleanup()

    def new_client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def request(self, path, method='GET', body=None, client=None, csrf=''):
        req = urllib.request.Request(self.base+path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json', 'Origin':self.base,
                     'X-Requested-With':'ProjectBoard', 'X-CSRF-Token':csrf})
        try:
            with (client or self.client).open(req) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as exc:
            return exc.code, json.load(exc)

    def register(self, username='alice'):
        code, data = self.request('/api/register', 'POST', {
            'username':username, 'password':self.password, 'displayName':'项目负责人'})
        self.assertEqual(code,201,data)
        return data

    def login(self, username='alice', password=None, client=None):
        return self.request('/api/login','POST',{'username':username,'password':password or self.password},client=client)

    def test_registration_login_and_hashes(self):
        registered = self.register('Alice')
        self.assertEqual(registered['user']['username'],'alice')
        self.assertTrue(registered['recoveryCode'].startswith('RC-'))
        code, _ = self.request('/api/register','POST',{'username':'ALICE','password':self.password})
        self.assertEqual(code,409)
        self.assertEqual(self.login(password='wrong-password')[0],401)
        self.assertEqual(self.request('/api/login','POST',{'password':self.password})[0],400)
        code, logged = self.login('ALICE')
        self.assertEqual(code,200)
        self.assertEqual(logged['user']['id'],registered['user']['id'])
        self.assertNotIn('password',json.dumps(logged))
        self.assertNotIn('recoveryCode',logged)
        with self.http.store.connect() as db:
            row = db.execute("SELECT * FROM users WHERE username='alice'").fetchone()
            self.assertNotEqual(row['password_hash'],self.password)
            self.assertTrue(server.password_matches(self.password,row['password_hash']))
            self.assertNotIn(registered['recoveryCode'],row['recovery_hash'])
        self.assertEqual(self.request('/api/session')[1]['user']['username'],'alice')

    def test_password_change_revokes_other_sessions_and_keeps_data(self):
        self.register()
        _, logged = self.login()
        other = self.new_client()
        self.assertEqual(self.login(client=other)[0],200)
        code, project = self.request('/api/projects','POST',{'name':'保留的项目'},csrf=logged['csrf'])
        self.assertEqual(code,201)
        payload = {'currentPassword':'wrong','newPassword':'new-account-password-2026'}
        self.assertEqual(self.request('/api/change-password','POST',payload,csrf=logged['csrf'])[0],400)
        payload['currentPassword']=self.password
        self.assertEqual(self.request('/api/change-password','POST',payload,csrf='wrong')[0],403)
        code, changed = self.request('/api/change-password','POST',payload,csrf=logged['csrf'])
        self.assertEqual(code,200)
        self.assertNotEqual(changed['csrf'],logged['csrf'])
        self.assertEqual(self.request('/api/session',client=other)[0],401)
        self.assertEqual(self.request('/api/projects/'+project['project']['id'])[0],200)
        self.assertEqual(self.login()[0],401)
        self.assertEqual(self.login(password=payload['newPassword'])[0],200)

    def test_reset_rotates_recovery_code_and_revokes_sessions(self):
        registered = self.register()
        self.login()
        other = self.new_client()
        self.login(client=other)
        payload={'username':'alice','newPassword':'reset-account-password-2026','recoveryCode':'RC-invalid-code'}
        self.assertEqual(self.request('/api/reset-password','POST',payload)[0],400)
        payload['recoveryCode']=registered['recoveryCode']
        code, reset = self.request('/api/reset-password','POST',payload)
        self.assertEqual(code,200)
        self.assertNotEqual(reset['recoveryCode'],registered['recoveryCode'])
        self.assertEqual(self.request('/api/session')[0],401)
        self.assertEqual(self.request('/api/session',client=other)[0],401)
        self.assertEqual(self.login()[0],401)
        self.assertEqual(self.login(password=payload['newPassword'])[0],200)
        self.assertEqual(self.request('/api/reset-password','POST',{**payload,'newPassword':'another-password-2026'})[0],400)
        payload['recoveryCode']=reset['recoveryCode']
        self.assertEqual(self.request('/api/reset-password','POST',payload)[0],400)  # identical password
        payload['newPassword']='another-password-2026'
        self.assertEqual(self.request('/api/reset-password','POST',payload)[0],200)

    def test_account_project_and_task_access_isolation(self):
        self.register()
        _, logged = self.login()
        self.assertEqual(self.request('/api/projects')[1]['projects'],[])
        for suffix in ['', '/export', '/tasks/1.1/history']:
            self.assertEqual(self.request('/api/projects/haikang'+suffix)[0],404)
        self.assertEqual(self.request('/api/projects/haikang/archive','POST',{'version':1},csrf=logged['csrf'])[0],404)
        self.assertEqual(self.request('/api/projects/haikang/tasks/1.1','PUT',{'version':1},csrf=logged['csrf'])[0],404)
        _, project = self.request('/api/projects','POST',{'name':'Alice 的项目'},csrf=logged['csrf'])
        self.register('bobby')
        self.login('bobby')
        self.assertEqual(self.request('/api/projects/'+project['project']['id'])[0],404)
        self.assertEqual(self.request('/api/projects')[1]['projects'],[])
        self.login('admin',os.environ['BOARD_PASSWORD'])
        self.assertEqual(self.request('/api/projects/haikang')[0],200)
        self.assertEqual(self.request('/api/projects/'+project['project']['id'])[0],404)

    def test_validation_and_persistent_rate_limit(self):
        for username,password in [('abc',self.password),('not valid',self.password),('goodname','short')]:
            self.assertEqual(self.request('/api/register','POST',{'username':username,'password':password})[0],400)
        self.register()
        for _ in range(10):
            self.assertEqual(self.request('/api/reset-password','POST',{'username':'alice','newPassword':'reset-password-2026','recoveryCode':'RC-invalid-code'})[0],400)
        self.assertEqual(self.request('/api/reset-password','POST',{'username':'alice','newPassword':'reset-password-2026','recoveryCode':'RC-invalid-code'})[0],429)
        reopened=server.Store(self.temp.name)
        with reopened.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM auth_attempts WHERE scope='reset'").fetchone()[0],10)

    def test_recovery_code_can_only_be_used_once_concurrently(self):
        registration=self.register()
        body={'username':'alice','newPassword':'parallel-password-2026','recoveryCode':registration['recoveryCode']}
        def reset(_):
            return self.request('/api/reset-password','POST',body,client=self.new_client())[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            results=list(executor.map(reset,[1,2]))
        self.assertEqual(sorted(results),[200,400])


class LegacyMigrationTest(unittest.TestCase):
    def test_preserves_legacy_projects_tasks_revisions_and_password(self):
        with tempfile.TemporaryDirectory() as directory:
            password='original-workspace-password'
            path=Path(directory)/'project.sqlite3'
            task=server.validate_task({'id':'1.1','title':'已维护任务','stage':'原项目','status':'进行中','priority':'高','progress':0.6,'evidence':'已保存的交付记录'})
            with sqlite3.connect(str(path)) as db:
                db.executescript('''
                    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
                    CREATE TABLE projects(id TEXT PRIMARY KEY,data TEXT NOT NULL,version INTEGER NOT NULL,archived INTEGER NOT NULL,updated_at TEXT NOT NULL);
                    CREATE TABLE tasks(project_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,version INTEGER NOT NULL,archived INTEGER NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,id));
                    CREATE TABLE revisions(seq INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,task_id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,archived INTEGER NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,task_id,version));
                    CREATE TABLE sessions(token TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires REAL NOT NULL);
                ''')
                db.execute("INSERT INTO meta VALUES('initialized','1')")
                db.execute("INSERT INTO meta VALUES('password',?)",(server.hash_password(password),))
                db.execute('INSERT INTO projects VALUES(?,?,?,?,?)',('haikang',json.dumps({'name':'原有项目'}),7,0,server.now()))
                db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?)',('haikang','1.1',json.dumps(task),5,0,server.now()))
                db.execute('INSERT INTO revisions(project_id,task_id,version,data,archived,action,created_at) VALUES(?,?,?,?,?,?,?)',('haikang','1.1',5,json.dumps(task),0,'原修改记录',server.now()))
                db.execute('INSERT INTO sessions VALUES(?,?,?)',('old-token','old-csrf',9999999999))
            store=server.Store(directory)
            snapshot=store.snapshot('haikang')
            self.assertEqual(snapshot['project']['version'],7)
            self.assertEqual(snapshot['tasks'][0]['version'],5)
            self.assertEqual(snapshot['tasks'][0]['evidence'],task['evidence'])
            with store.connect() as db:
                user=db.execute("SELECT * FROM users WHERE username='admin'").fetchone()
                self.assertTrue(server.password_matches(password,user['password_hash']))
                original_recovery=user['recovery_hash']
                self.assertEqual(db.execute('SELECT owner_id FROM projects').fetchone()[0],'admin')
                self.assertEqual(db.execute('SELECT COUNT(*) FROM revisions').fetchone()[0],1)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM sessions').fetchone()[0],0)
                self.assertFalse(db.execute("SELECT 1 FROM meta WHERE key='password'").fetchone())
            self.assertTrue((Path(directory)/'管理员账号与恢复码.txt').exists())
            backup_files=sorted(store.backup_dir.glob('*.sqlite3'))
            with sqlite3.connect(str(backup_files[0])) as backup:
                self.assertIsNone(backup.execute("SELECT 1 FROM sqlite_master WHERE name='users'").fetchone())
            again=server.Store(directory)
            with again.connect() as db:
                self.assertEqual(db.execute('SELECT recovery_hash FROM users').fetchone()[0],original_recovery)


if __name__=='__main__':
    unittest.main(verbosity=2)
