import http.cookiejar
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

import server
from work_calendar import DEFAULT_CALENDARS, calculate_workload, calendar_from_text, enrich_task, project_metrics, validate_calendar


class WorkCalendarTest(unittest.TestCase):
    def test_single_day_weekend_holiday_and_makeup(self):
        cases = [('2026-10-08',8),('2026-10-11',0),('2026-10-01',0),('2026-10-10',8),('2026-01-04',8)]
        for day,hours in cases:
            with self.subTest(day=day):
                result=calculate_workload(day,day,DEFAULT_CALENDARS)
                self.assertEqual(result['hours'],hours)
                self.assertEqual(result['calendarDays'],1)

    def test_official_holiday_ranges_cross_year_and_annual_totals(self):
        for start,end,hours,makeup in [('2026-10-01','2026-10-10',24,1),('2026-02-14','2026-02-28',48,2),('2025-12-31','2026-01-04',16,1)]:
            result=calculate_workload(start,end,DEFAULT_CALENDARS)
            self.assertEqual(result['hours'],hours)
            self.assertEqual(result['makeupDays'],makeup)
            self.assertEqual(result['workingDays']+result['restDays'],result['calendarDays'])
        for year in [2025,2026]:
            result=calculate_workload(str(year)+'-01-01',str(year)+'-12-31',DEFAULT_CALENDARS)
            self.assertEqual(result['workingDays'],248)
            self.assertEqual(result['hours'],1984)

    def test_missing_calendar_and_dates_are_not_silently_estimated(self):
        result=calculate_workload('2026-12-31','2027-01-04',DEFAULT_CALENDARS)
        self.assertEqual(result['status'],'calendar_missing')
        self.assertEqual(result['missingYears'],[2027])
        self.assertIsNone(result['hours'])
        for start,end,status in [('', '2026-10-08','dates_missing'),('2026-02-30','2026-03-01','invalid_dates'),('2026-10-10','2026-10-08','invalid_range')]:
            self.assertEqual(calculate_workload(start,end,DEFAULT_CALENDARS)['status'],status)

    def test_leap_day_and_invalid_calendar_rules(self):
        custom=validate_calendar(2024,{'sourceTitle':'测试日历','holidays':[],'workdays':[]})
        self.assertEqual(calculate_workload('2024-02-28','2024-03-01',{'2024':custom})['hours'],24)
        for body in [
            {'holidayText':'2026-01-01~2026-01-03 | 元旦','makeupText':'2026-01-01'},
            {'holidayText':'2026-01-01~2026-01-03\n2026-01-03~2026-01-04','makeupText':''},
            {'holidayText':'2026-02-30','makeupText':''},
            {'holidayText':'2027-01-01','makeupText':''},
            {'holidayText':'not a date','makeupText':''}
        ]:
            with self.assertRaises(ValueError):
                calendar_from_text(2026,{'sourceTitle':'测试',**body})

    def test_progress_includes_partial_work_and_weights_by_hours(self):
        task=lambda id,start,end,progress:enrich_task({'id':id,'start':start,'end':end,'progress':progress,'status':'进行中'},DEFAULT_CALENDARS)
        tasks=[task('a','2026-10-08','2026-10-10',0.5),task('b','2026-10-08','2026-10-08',1)]
        result=project_metrics(tasks)
        self.assertEqual(result['plannedHours'],32)
        self.assertEqual(result['progress'],62.5)
        self.assertEqual(result['progressMethod'],'hours')
        self.assertEqual(result['completedEquivalentHours'],20)
        tasks.append({**task('c','','',0.75),'archived':True})
        self.assertEqual(project_metrics(tasks)['progress'],62.5)
        tasks[1]=task('b','','',1)
        self.assertEqual(project_metrics(tasks)['progressMethod'],'tasks')
        self.assertEqual(project_metrics(tasks)['progress'],75)
        self.assertEqual(project_metrics(tasks)['uncalculatedTaskCount'],1)


class CalendarAPITest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=tempfile.TemporaryDirectory()
        cls.password='calendar-admin-password-2026'
        os.environ['BOARD_PASSWORD']=cls.password
        cls.http=server.make_server(cls.temp.name,port=0)
        cls.base='http://127.0.0.1:'+str(cls.http.server_port)
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();cls.temp.cleanup()

    def setUp(self):
        self.client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf=''
        code,data=self.request('/api/login','POST',{'username':'admin','password':self.password})
        self.assertEqual(code,200)
        self.csrf=data['csrf']

    def request(self,path,method='GET',body=None):
        req=urllib.request.Request(self.base+path,method=method,data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type':'application/json','Origin':self.base,'X-Requested-With':'ProjectBoard','X-CSRF-Token':self.csrf})
        try:
            with self.client.open(req) as response:return response.status,json.load(response)
        except urllib.error.HTTPError as exc:return exc.code,json.load(exc)

    def test_calendar_edit_recalculates_workload_without_overwriting_task_records(self):
        _,created=self.request('/api/projects','POST',{'name':'工时验证项目','tasks':[{'id':'TEST-HOURS','title':'国庆后交付','stage':'交付','owner':'张三','status':'进行中','priority':'高','start':'2026-10-01','end':'2026-10-10','progress':0.5}]})
        base='/api/projects/'+created['project']['id']
        code,data=self.request(base)
        self.assertEqual(code,200)
        self.assertEqual(data['tasks'][0]['workload']['hours'],24)
        self.assertEqual(data['summary']['progress'],50)
        self.assertEqual(data['summary']['progressMethod'],'hours')
        official=DEFAULT_CALENDARS['2026']
        body={'version':0,'sourceTitle':'测试账号自定义全年日历','sourceUrl':official['sourceUrl'],
              'holidayText':'\n'.join(h['start']+'~'+h['end']+' | '+h['name'] for h in official['holidays'])+'\n2026-10-08 | 测试放假',
              'makeupText':'\n'.join(official['workdays'])}
        self.assertEqual(self.request('/api/calendar/2026','PUT',body)[0],200)
        self.assertEqual(self.request('/api/calendar/2026','PUT',body)[0],409)
        _,changed=self.request(base)
        self.assertEqual(changed['tasks'][0]['workload']['hours'],16)
        self.assertEqual(changed['tasks'][0]['version'],1)
        self.assertEqual(changed['tasks'][0]['owner'],'张三')
        _,exported=self.request(base+'/export')
        self.assertEqual(exported['workCalendar']['years']['2026']['version'],1)
        self.assertEqual(exported['tasks'][0]['workload']['hours'],16)
        reopened=server.Store(self.temp.name)
        self.assertEqual(reopened.snapshot(created['project']['id'])['summary']['plannedHours'],16)
        with reopened.connect() as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM calendar_revisions WHERE user_id='admin' AND year=2026").fetchone()[0],1)
        self.assertEqual(self.request('/api/register','POST',{'username':'calendar.user','password':'calendar-member-password-2026'})[0],201)
        _,session=self.request('/api/login','POST',{'username':'calendar.user','password':'calendar-member-password-2026'})
        self.csrf=session['csrf']
        _,calendars=self.request('/api/calendar')
        self.assertFalse(calendars['years']['2026']['custom'])
        self.assertEqual(self.request('/api/work-hours','POST',{'start':'2026-10-01','end':'2026-10-10'})[1]['workload']['hours'],24)
        self.assertEqual(self.request(base)[0],404)


if __name__=='__main__':
    unittest.main(verbosity=2)
