import base64
import io
import json
import socket
import unittest
import zipfile
from unittest.mock import patch

import work_import as imp
from tests import test_server as workspace


def xlsx():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="需求" r:id="rId1"/></sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        archive.writestr('xl/worksheets/sheet1.xml', '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">'+''.join('<c r="'+chr(65+i)+'1" t="inlineStr"><is><t>'+s+'</t></is></c>' for i, s in enumerate(['任务名称','负责人','开始日期','结束日期','进度']))+'</row><row r="3"><c r="A3" t="inlineStr"><is><t>交付验证</t></is></c><c r="B3" t="inlineStr"><is><t>张三</t></is></c><c r="C3"><v>46330</v></c><c r="D3"><v>46339</v></c><c r="E3"><v>0.5</v></c></row></sheetData></worksheet>')
    return buffer.getvalue()


class ParserTest(unittest.TestCase):
    def test_csv_encoding_dates_progress_and_other_fields(self):
        text = '编号,阶段,任务名称,负责人,开始时间,结束时间,进度,状态,备注\nA1,需求,访谈,张三,2026年10月1日,2026/10/10,50%,执行中,等待确认\nA2,,评审,李四,错误日期,,完成,未开始,'
        data = imp.parse_document(text.encode('gb18030'), '工作.csv')
        a, b = [r['task'] for r in data['rows']]
        self.assertEqual((a['start'], a['end'], a['progress'], a['status']), ('2026-10-01', '2026-10-10', .5, '进行中'))
        self.assertIn('备注：等待确认', a['content'])
        self.assertEqual(b['start'], '错误日期')
        self.assertEqual(b['stage'], '需求')
        self.assertEqual(b['progress'], '完成')
        bad = imp.normalize({'任务名称': '测试', '进度': 'NaN'}, '1')
        self.assertEqual(bad['task']['progress'], 'NaN')
        done = imp.normalize({'任务名称': '完成工作', '状态': '已完成'}, '1')
        self.assertIn('progress', done['fields'])

    def test_xlsx_sparse_rows_and_excel_dates(self):
        data = imp.parse_document(xlsx(), '计划.xlsx')
        task = data['rows'][0]['task']
        self.assertEqual(data['sheets'], ['需求'])
        self.assertEqual(task['start'], '2026-11-04')
        self.assertEqual(task['progress'], .5)
        self.assertIn('第 3 行', data['rows'][0]['location'])
        self.assertEqual(imp.date_value('1', True, True), '1904-01-02')

    def test_docx_markdown_html_and_backup(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>需求阶段：</w:t></w:r></w:p><w:p><w:r><w:t>1. 用户访谈，负责人：李四，截止：2026-11-08</w:t></w:r></w:p></w:body></w:document>')
        self.assertEqual(imp.parse_document(buffer.getvalue(), 'a.docx')['rows'][0]['task']['owner'], '李四')
        md = '| 任务名称 | 负责人 |\n|---|---|\n| 接口评审 | 张三 |'
        self.assertEqual(imp.parse_document(md.encode(), 'a.md')['rows'][0]['task']['title'], '接口评审')
        html = '<table><tr><th>任务名称</th><th>负责人</th></tr><tr><td>验收</td><td>王五</td></tr></table>'
        self.assertEqual(imp.parse_document(html.encode(), 'a.html')['rows'][0]['task']['owner'], '王五')
        backup = {'project': {'id': 'original'}, 'tasks': [{'id': 'X', 'title': '访谈', 'stage': '需求', 'status': '未开始', 'progress': None, 'decision': '已确认', 'workload': {'hours': 8}}]}
        parsed = imp.parse_document(json.dumps(backup).encode(), 'a.json')
        self.assertEqual(parsed['sourceProject'], 'original')
        self.assertEqual(parsed['rows'][0]['task']['decision'], '已确认')

    def test_malformed_and_unreadable_sources_are_explicit(self):
        for raw, name in [(b'<html><h1>Login</h1></html>', 'a.html'), (b'bad', 'a.xls'),
                          ('任务名称,负责人,owner\n测试,张三,李四'.encode(), 'a.csv'),
                          ('任务名称,负责人\n测试,张三,其他'.encode(), 'a.csv')]:
            with self.subTest(name=name), self.assertRaises(imp.ImportProblem):
                imp.parse_document(raw, name)
        with self.assertRaises(imp.ImportProblem):
            imp.xml(b'<!DOCTYPE foo [<!ENTITY x "bad">]><x/>')
        with self.assertRaises(imp.ImportProblem):
            imp.parse_document(('任务名称,负责人\n'+'工作,张三\n'*2001).encode(), 'a.csv')

    def test_urls_dns_and_redirects_do_not_leak_tokens(self):
        for url in ['http://docs.qq.com/a', 'https://docs.qq.com:8443/a', 'https://docs.qq.com.evil.test/a', 'https://user:pass@docs.qq.com/a', 'https://127.0.0.1/a', 'file:///tmp/a']:
            with self.subTest(url=url), self.assertRaises(imp.ImportProblem):
                imp.checked_url(url)
        with patch.object(socket, 'getaddrinfo', return_value=[(2,1,6,'',('127.0.0.1',443))]), self.assertRaises(imp.ImportProblem):
            imp.public_addresses('docs.qq.com')
        calls = []
        class Response:
            def __init__(self, redirect): self.status = 302 if redirect else 200
            def getheader(self, key, default=None): return 'https://files.myqcloud.com/a.csv' if key == 'Location' else default
            def read(self, limit): return b'content'
        class Connection:
            def __init__(self, host, **kwargs): self.host = host
            def request(self, method, path, headers): calls.append((self.host, headers))
            def getresponse(self): return Response(self.host == 'docs.qq.com')
            def close(self): pass
        with patch.object(imp, 'PinnedHTTPS', Connection):
            imp.fetch('https://docs.qq.com/a', {'Access-Token': 'secret'})
        self.assertIn('Access-Token', calls[0][1])
        self.assertNotIn('Access-Token', calls[1][1])

    def test_provider_adapters_and_no_signed_url_provenance(self):
        responses = [
            {'data': {'node': {'obj_type': 'sheet', 'obj_token': 'sheetToken'}}},
            {'data': {'sheets': [{'sheet_id': 'S1', 'title': '工作', 'grid_properties': {'row_count': 2, 'column_count': 2}}]}},
            {'data': {'valueRange': {'values': [['任务名称','负责人'],['验收','张三']]}}},
        ]
        with patch.object(imp, 'api_json', side_effect=responses) as api:
            data = imp.read_link('https://team.feishu.cn/wiki/abc?token=SECRET', {'token': 'temporary'})
            self.assertEqual(data['rows'][0]['task']['title'], '验收')
            self.assertNotIn('SECRET', data['source'])
            self.assertEqual(api.call_args[0][1]['Authorization'], 'Bearer temporary')
        responses = [{'data': {'fileID': '123$ABC'}}, {'data': {'url': 'https://files.myqcloud.com/a.xlsx?sign=private'}}]
        with patch.object(imp, 'api_json', side_effect=responses), patch.object(imp, 'fetch', return_value=(xlsx(), '', '')):
            data = imp.read_link('https://docs.qq.com/sheet/DABC', {'token': 't', 'clientId': 'c', 'openId': 'o'})
            self.assertEqual(len(data['rows']), 1)
        responses = [{'value': [{'id': 'S1', 'name': '清单'}]}, {'rowCount':2,'columnCount':2}, {'displayValues':[['任务名称','负责人'],['测试','王五']]}]
        with patch.object(imp, 'api_json', side_effect=responses):
            data = imp.read_link('https://alidocs.dingtalk.com/i/nodes/opaque', {'token': 't', 'operatorId': 'o', 'documentId': 'wb'})
            self.assertEqual(data['rows'][0]['task']['owner'], '王五')


class ImportAPITest(unittest.TestCase):
    setUpClass = classmethod(workspace.WorkspaceTest.setUpClass.__func__)
    tearDownClass = classmethod(workspace.WorkspaceTest.tearDownClass.__func__)
    setUp = workspace.WorkspaceTest.setUp
    request = workspace.WorkspaceTest.request
    create = workspace.WorkspaceTest.create

    def preview(self, base, text):
        code, data = self.request(base+'/import-preview', 'POST', {'kind':'file','name':'计划.csv','content':base64.b64encode(text.encode()).decode()})
        self.assertEqual(code, 200, data)
        return data

    def test_preview_save_retry_restart_and_atomic_validation(self):
        project, _ = self.create()
        base = '/api/projects/'+project['id']
        preview = self.preview(base, '编号,任务名称,负责人,开始日期,结束日期,进度\nT-001,新工作,王五,2026-10-01,2026-10-10,50%\nNEW-2,另一项,李四,错误日期,,')
        self.assertNotEqual(preview['rows'][0]['task']['id'], 'T-001')
        self.assertTrue(preview['rows'][1]['errors'])
        self.assertEqual(len(self.request(base)[1]['tasks']), 3)
        payload = {'mode':'append','rows':[{'index':i,'task':r['task']} for i,r in enumerate(preview['rows'])]}
        endpoint = base+'/import-batches/'+preview['batchId']+'/save'
        self.assertEqual(self.request(endpoint, 'POST', payload)[0], 400)
        self.assertEqual(len(self.request(base)[1]['tasks']), 3)
        payload['rows'][1]['task']['start'] = '2026-11-01'
        code, result = self.request(endpoint,'POST',payload)
        self.assertEqual(code,200,result)
        self.assertEqual(result['added'],2)
        self.assertEqual(self.request(endpoint,'POST',payload)[1],result)
        snapshot = self.request(base)[1]
        self.assertEqual(len(snapshot['tasks']),5)
        task = next(t for t in snapshot['tasks'] if t['id']==preview['rows'][0]['task']['id'])
        self.assertEqual(task['workload']['hours'],24)
        reopened = workspace.server.Store(self.temp.name)
        self.assertEqual(len(reopened.snapshot(project['id'])['tasks']),5)
        payload['rows'][0]['task']['owner']='changed'
        self.assertEqual(self.request(endpoint,'POST',payload)[0],409)

    def test_merge_keeps_missing_fields_and_detects_conflicts(self):
        project, _ = self.create()
        base = '/api/projects/'+project['id']
        before = self.request(base)[1]['tasks'][0]
        data = self.preview(base,'编号,任务名称,负责人\nT-001,更新名称,')
        row = data['rows'][0]['task'];row['id']='T-001'
        endpoint=base+'/import-batches/'+data['batchId']+'/save'
        self.assertEqual(self.request(endpoint,'POST',{'mode':'merge','rows':[{'index':0,'task':row}]})[0],200)
        after=self.request(base)[1]['tasks'][0]
        self.assertEqual(after['title'],'更新名称')
        self.assertEqual(after['owner'],before['owner'])
        self.assertEqual(after['nextAction'],before['nextAction'])
        self.assertEqual(after['stage'],before['stage'])
        data=self.preview(base,'编号,任务名称,负责人\nT-001,冲突测试,张三')
        after['decision']='其他页面更新'
        self.assertEqual(self.request(base+'/tasks/T-001','PUT',after)[0],200)
        row=data['rows'][0]['task'];row['id']='T-001'
        self.assertEqual(self.request(base+'/import-batches/'+data['batchId']+'/save','POST',{'mode':'merge','rows':[{'index':0,'task':row}]})[0],409)

    def test_accounts_and_auth_secrets_are_not_persisted(self):
        project,_=self.create()
        base='/api/projects/'+project['id']
        fake=imp.parse_document('任务名称,负责人\n测试,张三'.encode(),'a.csv')
        fake['source']='https://team.feishu.cn/sheets/a'
        with patch.object(workspace.server,'read_link',return_value=fake):
            code,data=self.request(base+'/import-preview','POST',{'kind':'link','url':'https://team.feishu.cn/sheets/a','auth':{'token':'NEVER_PERSIST_THIS'}})
        self.assertEqual(code,200,data)
        with self.http.store.connect() as db:
            row=db.execute('SELECT data,versions FROM import_batches WHERE id=?',(data['batchId'],)).fetchone()
            self.assertNotIn('NEVER_PERSIST_THIS',str(tuple(row)))
        self.request('/api/register','POST',{'username':'import.member','displayName':'成员','password':'member-test-password-2026'})
        _,login=self.request('/api/login','POST',{'username':'import.member','password':'member-test-password-2026'})
        self.csrf=login['csrf']
        self.assertEqual(self.request(base+'/import-batches/'+data['batchId'])[0],404)
        self.assertEqual(self.request(base+'/import-batches/'+data['batchId']+'/save','POST',{'rows':[]})[0],404)


if __name__=='__main__':
    unittest.main()
