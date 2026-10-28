"""China mainland work calendar and auditable, date-inclusive planning calculations."""
import datetime as dt
import json
from pathlib import Path
import re

HOURS_PER_DAY = 8
DEFAULT_CALENDARS = json.loads((Path(__file__).resolve().parent / 'seed/cn-holidays.json').read_text())['years']


def parse_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('请使用 YYYY-MM-DD 格式填写日期')
    return dt.date.fromisoformat(value)


def validate_calendar(year, value):
    if type(year) is not int or not 1900 <= year <= 2200:
        raise ValueError('日历年份需要在 1900 至 2200 之间')
    source_title, source_url = value.get('sourceTitle', ''), value.get('sourceUrl', '')
    if not isinstance(source_title, str) or not 1 <= len(source_title.strip()) <= 200:
        raise ValueError('请填写日历依据或通知名称')
    if not isinstance(source_url, str) or len(source_url) > 2000 or (source_url and not source_url.startswith('https://')):
        raise ValueError('通知链接需要使用 HTTPS，或留空')
    holidays, workdays = value.get('holidays', []), value.get('workdays', [])
    if not isinstance(holidays, list) or not isinstance(workdays, list) or len(holidays) > 100 or len(workdays) > 366:
        raise ValueError('日历条目格式或数量无效')
    result, holiday_dates, work_dates = [], set(), set()
    for holiday in holidays:
        if not isinstance(holiday, dict):
            raise ValueError('放假安排格式无效')
        start, end = parse_date(holiday.get('start')), parse_date(holiday.get('end'))
        name = holiday.get('name', '放假')
        if not isinstance(name, str) or len(name) > 80 or start.year != year or end.year != year or end < start:
            raise ValueError('放假日期必须在指定年份内，结束日期不得早于开始日期')
        for index in range((end-start).days+1):
            day = (start + dt.timedelta(days=index)).isoformat()
            if day in holiday_dates:
                raise ValueError('放假区间重复或重叠：' + day)
            holiday_dates.add(day)
        result.append({'start': start.isoformat(), 'end': end.isoformat(), 'name': name.strip() or '放假'})
    for value in workdays:
        day = parse_date(value)
        if day.year != year:
            raise ValueError('补班日期必须在指定年份内')
        if value in holiday_dates or value in work_dates:
            raise ValueError('补班日期重复或与放假日期冲突：' + value)
        work_dates.add(value)
    return {'year': year, 'sourceTitle': source_title.strip(), 'sourceUrl': source_url.strip(),
            'holidays': sorted(result, key=lambda h: h['start']), 'workdays': sorted(work_dates)}


def calendar_from_text(year, value):
    holiday_text, makeup_text = value.get('holidayText', ''), value.get('makeupText', '')
    if not isinstance(holiday_text, str) or not isinstance(makeup_text, str) or len(holiday_text) > 20000 or len(makeup_text) > 10000:
        raise ValueError('日历文本格式或长度无效')
    holidays = []
    for line in holiday_text.splitlines():
        if not line.strip():
            continue
        match = re.fullmatch(r'\s*(\d{4}-\d{2}-\d{2})(?:\s*[~～至]\s*(\d{4}-\d{2}-\d{2}))?(?:\s*[|｜]\s*(.{1,80}))?\s*', line)
        if not match:
            raise ValueError('放假安排格式：2026-01-01~2026-01-03 | 元旦')
        start, end, name = match.groups()
        holidays.append({'start': start, 'end': end or start, 'name': name or '放假'})
    workdays = [part for part in re.split(r'[\s,，;；]+', makeup_text.strip()) if part]
    return validate_calendar(year, {**value, 'holidays': holidays, 'workdays': workdays})


def calculate_workload(start, end, calendars):
    base = {'hoursPerDay': HOURS_PER_DAY, 'inclusive': True, 'hours': None, 'workingDays': None,
            'calendarDays': None, 'restDays': None, 'holidayDays': None, 'weekendDays': None,
            'makeupDays': None, 'missingYears': []}
    if not start or not end:
        return {**base, 'status': 'dates_missing'}
    try:
        first, last = parse_date(start), parse_date(end)
    except (ValueError, TypeError):
        return {**base, 'status': 'invalid_dates'}
    span = (last-first).days+1
    if span < 1 or span > 36600:
        return {**base, 'status': 'invalid_range'}
    missing = [year for year in range(first.year, last.year+1) if str(year) not in calendars]
    if missing:
        return {**base, 'calendarDays': span, 'status': 'calendar_missing', 'missingYears': missing}
    working = holidays = weekends = makeup = 0
    for index in range(span):
        day = first + dt.timedelta(days=index)
        date, calendar = day.isoformat(), calendars[str(day.year)]
        if date in calendar['workdays']:
            working += 1
            makeup += int(day.weekday() >= 5)
        elif any(h['start'] <= date <= h['end'] for h in calendar['holidays']):
            holidays += 1
        elif day.weekday() >= 5:
            weekends += 1
        else:
            working += 1
    return {**base, 'status': 'ready', 'calendarDays': span, 'workingDays': working,
            'restDays': span-working, 'holidayDays': holidays, 'weekendDays': weekends,
            'makeupDays': makeup, 'hours': working*HOURS_PER_DAY}


def enrich_task(task, calendars):
    return {**task, 'workload': calculate_workload(task.get('start'), task.get('end'), calendars)}


def project_metrics(tasks):
    active = [task for task in tasks if not task.get('archived')]
    hours = sum(task['workload']['hours'] or 0 for task in active)
    ready = sum(task['workload']['hours'] is not None for task in active)
    known = [task for task in active if task.get('progress') is not None]
    weighted = bool(active) and ready == len(active) and len(known) == len(active) and hours > 0
    percent = (sum(task['workload']['hours']*task['progress'] for task in active)/hours*100
               if weighted else sum(task['progress'] for task in known)/len(known)*100 if known else 0)
    completed_hours = sum((task['workload']['hours'] or 0)*(task.get('progress') or 0) for task in active)
    return {'total': len(active), 'completed': sum(task['status']=='已完成' and task.get('progress')==1 for task in active),
            'plannedHours': hours, 'calculatedTaskCount': ready, 'uncalculatedTaskCount': len(active)-ready,
            'progress': round(percent, 1), 'progressMethod': 'hours' if weighted else 'tasks',
            'progressKnownCount': len(known), 'unknownProgressCount': len(active)-len(known),
            'completedEquivalentHours': round(completed_hours, 1),
            'missingCalendarYears': sorted({year for task in active for year in task['workload']['missingYears']})}
