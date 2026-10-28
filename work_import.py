"""Bounded document parsers and permission-aware cloud document readers.

Only source content is returned. Credentials live only in the current request.
"""
import csv
import datetime as dt
import http.client
import io
import ipaddress
import json
import math
import posixpath
import re
import socket
import ssl
import zipfile
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlsplit, urlunsplit
from xml.etree import ElementTree as ET

MAX_FILE = 2_000_000
MAX_ROWS = 2000
MAX_CELLS = 250_000
MAX_REMOTE = 4_000_000


class ImportProblem(ValueError):
    pass


ALIASES = {
    'id': '编号,任务编号,工作编号,WBS,ID,序号',
    'title': '任务,任务名称,工作项,工作事项,事项,任务标题,标题,工作名称,工作任务,title,task',
    'content': '工作内容,具体工作内容,任务内容,内容,工作描述,任务描述,说明,content,description',
    'stage': '阶段,项目阶段,工作阶段,所属阶段,stage,phase',
    'owner': '负责人,责任人,主责人,责任人姓名,owner,assignee',
    'collaborator': '协作人,配合人,参与人,collaborator',
    'status': '状态,当前状态,当前进行状态,任务状态,工作状态,status',
    'start': '开始时间,开始日期,计划开始,计划开始时间,计划开始日期,start,startdate',
    'end': '结束时间,结束日期,计划结束,计划结束时间,计划结束日期,截止日期,截止时间,end,enddate,due',
    'progress': '进度,进度百分比,完成率,完成进度,进度%,进度（%）,进度(%),progress,percent',
    'priority': '优先级,priority',
    'criteria': '验收标准,交付物,交付成果,criteria,deliverable',
    'nextAction': '下一步,下一步行动,后续计划,nextaction',
    'blocker': '阻碍,风险,问题,blocker',
    'evidence': '成果链接,交付链接,证据,evidence',
    'actualEnd': '实际结束,实际完成日期,actualend',
    'followup': '跟进日期,下次跟进,followup',
    'decision': '决策,决策记录,decision',
    'acceptance': '验收结论,acceptance',
    'originalAction': '原计划工作,originalaction',
    'originalDeliverable': '原计划交付物,originaldeliverable',
}


def header_key(value):
    return re.sub(r'[\s_\-：:]', '', str(value)).lower().strip('\ufeff')


HEADERS = {header_key(alias): key for key, names in ALIASES.items()
           for alias in [key, *names.split(',')]}
STATUS = {'未启动': '未开始', '待开始': '未开始', '待办': '未开始', 'todo': '未开始',
          'inprogress': '进行中', '执行中': '进行中', '完成': '已完成', 'done': '已完成',
          '延期': '已延期', 'blocked': '受阻', '暂停中': '暂停', '待审核': '待验收'}


def text_value(value):
    if value is None:
        return ''
    if isinstance(value, (dict, list)):
        raise ImportProblem('单元格含有不支持的嵌套数据，请先导出为普通表格')
    return str(value).strip()


def date_value(value, excel=False, epoch1904=False):
    value = text_value(value)
    if not value:
        return ''
    if excel and re.fullmatch(r'\d+(?:\.\d+)?', value):
        days = float(value)
        if 1 <= days <= 2950000:
            epoch = dt.date(1904, 1, 1) if epoch1904 else dt.date(1899, 12, 30)
            return (epoch + dt.timedelta(days=int(days))).isoformat()
    match = re.fullmatch(r'(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?', value)
    if match:
        try:
            return dt.date(*map(int, match.groups())).isoformat()
        except ValueError:
            pass
    return value  # Keep malformed values visible for correction in preview.


def normalize(record, location, excel=False, epoch1904=False):
    task, fields, warnings, extra = {}, [], [], []
    for key, raw in record.items():
        field = HEADERS.get(header_key(key))
        if not field:
            if key not in ['version', 'archived', 'updatedAt', 'workload', 'sourceRow'] and raw not in ['', None]:
                extra.append(str(key)+'：'+text_value(raw))
            continue
        value = text_value(raw)
        if field in task and value and task[field] != value:
            raise ImportProblem(location + '：多列映射至相同字段「' + field + '」，请合并后导入')
        task[field] = value
        if value:
            fields.append(field)
    for key in ['start', 'end', 'actualEnd', 'followup']:
        if key in task:
            task[key] = date_value(task[key], excel, epoch1904)
    status = task.get('status', '')
    task['status'] = STATUS.get(re.sub(r'\s', '', status).lower(), status) or '未开始'
    task['priority'] = task.get('priority') or '中'
    progress = task.get('progress', '')
    if progress:
        try:
            percent = progress.endswith(('%', '％'))
            number = float(progress.rstrip('%％'))
            if not math.isfinite(number):
                raise ValueError()
            task['progress'] = number / 100 if percent or number > 1 else number
            if not percent and 0 < number <= 1:
                warnings.append('进度 ' + progress + ' 按小数比例解析（' + str(round(number*100, 2)) + '%）')
        except ValueError:
            task['progress'] = progress
    else:
        task['progress'] = 1 if task['status'] == '已完成' else None
        if task['status'] == '已完成':
            fields.append('progress')
            warnings.append('已完成任务未填进度，按 100% 预览，请核对')
    if not task.get('title') and task.get('content'):
        task['title'] = task['content'][:120]
        fields.append('title')
        warnings.append('已从工作内容提取任务名称，请核对')
    task['stage'] = task.get('stage') or '项目实施'
    if extra:
        task['content'] = (task.get('content', '')+'\n原表其他字段：\n'+'\n'.join(extra)).strip()
        fields.append('content')
        warnings.append('其他未映射字段已保留在工作内容中，请核对')
    return {'task': task, 'fields': list(set(fields)), 'location': location, 'warnings': warnings}


def table_rows(rows, label, excel=False, epoch1904=False):
    if sum(len(row) for row in rows) > MAX_CELLS:
        raise ImportProblem('表格单元格过多，请拆分文件')
    header = None
    for index, row in enumerate(rows[:40]):
        mapped = [HEADERS.get(header_key(v)) for v in row]
        if ('title' in mapped or 'content' in mapped) and sum(v is not None for v in mapped) >= 2:
            header = index
            break
    if header is None:
        raise ImportProblem(label + '：未找到表头，请至少提供「任务名称 / 工作内容」和「负责人 / 状态 / 日期」等列')
    names, result, stage = rows[header], [], ''
    recognized = [HEADERS[header_key(name)] for name in names if header_key(name) in HEADERS]
    if len(set(recognized)) != len(recognized):
        raise ImportProblem(label+'：多个表头对应相同字段，请合并列后导入')
    for index, row in enumerate(rows[header+1:], header+2):
        if not any(text_value(v) for v in row):
            continue
        if len(row) > len(names) and any(text_value(v) for v in row[len(names):]):
            raise ImportProblem(label + '第 ' + str(index) + ' 行超出表头列数，请核对分隔符')
        record = {names[i]: value for i, value in enumerate(row) if i < len(names) and text_value(names[i])}
        normalized = normalize(record, label + ' · 第 ' + str(index) + ' 行', excel, epoch1904)
        if normalized['task'].get('stage') != '项目实施' or 'stage' in normalized['fields']:
            stage = normalized['task']['stage']
        elif stage:
            normalized['task']['stage'] = stage
            normalized['fields'].append('stage')
        result.append(normalized)
        if len(result) > MAX_ROWS:
            raise ImportProblem('一次最多导入 2000 项，文件未截断，请拆分后重试')
    return result


def xml(raw):
    if re.search(br'<!\s*(?:DOCTYPE|ENTITY)', raw, re.I):
        raise ImportProblem('文件含有不支持的 XML 声明')
    return ET.fromstring(raw)


def open_zip(raw):
    archive = zipfile.ZipFile(io.BytesIO(raw))
    entries = archive.infolist()
    if len(entries) > 1500 or sum(e.file_size for e in entries) > 20_000_000:
        raise ImportProblem('解压后文件过大，请拆分后导入')
    if len({e.filename for e in entries}) != len(entries) or any(e.flag_bits & 1 for e in entries):
        raise ImportProblem('不支持加密或包含重复条目的文件')
    return archive


def col_index(value):
    result = 0
    for char in value:
        result = result*26 + ord(char)-64
    return result-1


def col_name(index):
    result = ''
    while index:
        index, rem = divmod(index-1, 26)
        result = chr(65+rem)+result
    return result


def parse_xlsx(archive):
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    shared = []
    if 'xl/sharedStrings.xml' in archive.namelist():
        shared = [''.join(e.itertext()) for e in xml(archive.read('xl/sharedStrings.xml')).findall('s:si', ns)]
    workbook = xml(archive.read('xl/workbook.xml'))
    props = workbook.find('s:workbookPr', ns)
    epoch1904 = props is not None and props.get('date1904') in ['1', 'true']
    rels = {r.get('Id'): r.get('Target') for r in xml(archive.read('xl/_rels/workbook.xml.rels'))}
    result, sheets = [], []
    for sheet in workbook.findall('s:sheets/s:sheet', ns):
        target = rels.get(sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'), '')
        path = target.lstrip('/') if target.startswith('/') else posixpath.normpath('xl/'+target)
        if not path.startswith('xl/') or path not in archive.namelist():
            raise ImportProblem('工作表路径无效')
        document, rows = xml(archive.read(path)), []
        for node in document.findall('s:sheetData/s:row', ns):
            position = int(node.get('r', len(rows)+1))
            if position <= len(rows) or position > 10000:
                raise ImportProblem('工作表行号无效或超过 10000 行，请拆分文件')
            while len(rows) < position-1:
                rows.append([])
            row = []
            for cell in node.findall('s:c', ns):
                match = re.fullmatch(r'([A-Z]+)\d+', cell.get('r', ''))
                index = col_index(match.group(1)) if match else len(row)
                if index >= 256:
                    raise ImportProblem('仅支持最多 256 列的工作表，请删除多余列后导入')
                while len(row) <= index:
                    row.append('')
                value = cell.findtext('s:v', '', ns)
                if cell.get('t') == 's':
                    value = shared[int(value)] if value else ''
                elif cell.get('t') == 'inlineStr':
                    value = ''.join(cell.find('s:is', ns).itertext())
                elif cell.get('t') == 'e':
                    raise ImportProblem('表格含有公式错误，请在原文件中修正')
                if cell.find('s:f', ns) is not None and not value:
                    raise ImportProblem('表格公式缺少计算结果，请用 Excel 重新计算并保存后导入')
                row[index] = value
            rows.append(row)
            if len(rows) > 10000:
                raise ImportProblem('工作表行数过多，请拆分文件')
        if not any(any(v for v in row) for row in rows):
            continue
        name = sheet.get('name', '工作表')
        # Every nonempty sheet is accounted for; unknown sheets are never silently ignored.
        result.extend(table_rows(rows, name, True, epoch1904))
        sheets.append(name)
    return result, sheets


class Tables(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.rows, self.row, self.cell = [], None, None, None
        self.seed, self.in_seed = '', False

    def handle_starttag(self, tag, attrs):
        if tag == 'script' and dict(attrs).get('id') == 'seed-data':
            self.in_seed = True
        if tag == 'table':
            if self.rows is not None:
                raise ImportProblem('暂不支持嵌套表格，请导出为 Excel')
            self.rows = []
        elif tag == 'tr' and self.rows is not None:
            self.row = []
        elif tag in ['td', 'th'] and self.row is not None:
            attributes = dict(attrs)
            if attributes.get('rowspan', '1') != '1' or attributes.get('colspan', '1') != '1':
                raise ImportProblem('网页表格含有合并单元格，请导出为 Excel 后导入')
            self.cell = ''
        elif tag == 'br' and self.cell is not None:
            self.cell += '\n'

    def handle_endtag(self, tag):
        if tag == 'script':
            self.in_seed = False
        if tag in ['td', 'th'] and self.cell is not None:
            self.row.append(self.cell.strip())
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == 'table' and self.rows is not None:
            self.tables.append(self.rows)
            self.rows = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell += data
        if self.in_seed:
            self.seed += data


def parse_json(data):
    project = data.get('project', {}) if isinstance(data, dict) else {}
    records = data.get('tasks') if isinstance(data, dict) else data
    if not isinstance(records, list) or not all(isinstance(v, dict) for v in records):
        raise ImportProblem('JSON 应包含 tasks 数组或工作项对象数组')
    return [normalize(r, 'JSON · 第 '+str(i+1)+' 项') for i, r in enumerate(records)], project.get('id')


def parse_text(text, label):
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if any(line.count('|') >= 2 for line in lines[:10]):
        rows = [[v.strip() for v in line.strip('|').split('|')] for line in lines if line.count('|') >= 2
                and not re.fullmatch(r'[\s|:\-]+', line)]
        return table_rows(rows, label)
    stage, result = '项目实施', []
    for index, line in enumerate(lines, 1):
        if re.fullmatch(r'(?:#{1,4}\s+.+|.{2,25}[:：])', line):
            stage = re.sub(r'^#+\s*|[:：]$', '', line)
            continue
        line = re.sub(r'^\s*(?:[-*•]|\d+[.、)）])\s*', '', line)
        owner = re.search(r'(?:负责人|责任人|主责人)[:：]\s*([^，,；;|\s]+)', line)
        dates = re.findall(r'20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?', line)
        title = re.split(r'[|｜]|(?:负责人|责任人|主责人|截止|开始|计划开始|交付物|验收标准)[:：]', line)[0].strip(' ，,')
        result.append(normalize({'title': title, 'content': line, 'stage': stage, 'owner': owner.group(1) if owner else '',
                                 'start': dates[0] if len(dates) > 1 else '', 'end': dates[-1] if dates else ''}, label+' · 第 '+str(index)+' 行'))
    return result


def parse_document(raw, filename):
    if not raw or len(raw) > MAX_REMOTE:
        raise ImportProblem('文件为空或超过读取上限，请拆分后导入')
    suffix = filename.lower().rsplit('.', 1)[-1]
    result, sheets, project_id = [], [], None
    try:
        if raw.startswith(b'PK'):
            with open_zip(raw) as archive:
                if 'xl/workbook.xml' in archive.namelist():
                    result, sheets = parse_xlsx(archive)
                elif 'word/document.xml' in archive.namelist():
                    ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
                    body = xml(archive.read('word/document.xml')).find('w:body', ns)
                    paragraphs = []
                    for node in body:
                        if node.tag.endswith('}tbl'):
                            rows = [[''.join(c.itertext()) for c in r.findall('w:tc', ns)] for r in node.findall('w:tr', ns)]
                            result.extend(table_rows(rows, 'Word 表格'))
                        elif node.tag.endswith('}p'):
                            paragraphs.append(''.join(node.itertext()))
                    if not result:
                        result = parse_text('\n'.join(paragraphs), filename)
                else:
                    raise ImportProblem('压缩包不是受支持的 XLSX 或 DOCX 文件')
        elif suffix in ['xls', 'doc', 'pdf', 'png', 'jpg', 'jpeg']:
            raise ImportProblem('暂不支持该格式，请先导出为 XLSX、CSV、DOCX 或文本文件')
        else:
            try:
                text = raw.decode('utf-8-sig')
            except UnicodeDecodeError:
                text = raw.decode('gb18030')
            if suffix == 'json' or text.lstrip().startswith(('{', '[')):
                result, project_id = parse_json(json.loads(text))
            elif suffix in ['html', 'htm'] or re.search(r'<(?:!doctype|html|table)\b', text[:2000], re.I):
                doc = Tables()
                doc.feed(text)
                if doc.seed:
                    result, project_id = parse_json(json.loads(doc.seed))
                elif doc.tables:
                    for index, table in enumerate(doc.tables, 1):
                        result.extend(table_rows(table, '网页表格 '+str(index)))
                else:
                    raise ImportProblem('链接未返回可读取的工作清单，可能需要登录、授权或由平台动态加载。请填写授权信息，或从原平台导出文件后导入')
            elif suffix in ['csv', 'tsv']:
                delimiter = '\t' if suffix == 'tsv' else csv.Sniffer().sniff(text[:10000], delimiters=',;\t').delimiter
                result = table_rows(list(csv.reader(io.StringIO(text), delimiter=delimiter)), filename)
            elif suffix in ['txt', 'md', 'markdown']:
                result = parse_text(text, filename)
            else:
                raise ImportProblem('无法识别文件格式，请使用 XLSX、CSV、TSV、JSON、DOCX、TXT、Markdown 或 HTML')
    except ImportProblem:
        raise
    except (ValueError, KeyError, IndexError, OverflowError, AttributeError, ET.ParseError, zipfile.BadZipFile, csv.Error, UnicodeError):
        raise ImportProblem('文件格式损坏或内容无法识别，请重新导出后导入') from None
    if not result or len(result) > MAX_ROWS:
        raise ImportProblem('未找到工作项，或工作项超过 2000 条；请核对内容并分批导入')
    return {'rows': result, 'sheets': sheets, 'sourceProject': project_id}


DOMAINS = ('docs.qq.com', 'doc.weixin.qq.com', 'feishu.cn', 'larksuite.com', 'larkoffice.com',
           'dingtalk.com', 'alidocs.com', 'myqcloud.com', 'docx.qq.com')


def checked_url(url):
    if not isinstance(url, str) or len(url) > 8000 or re.search(r'[\x00-\x20\\]', url):
        raise ImportProblem('链接格式无效，请粘贴完整 HTTPS 文档链接')
    try:
        parts = urlsplit(url)
        host = parts.hostname or ''
        if parts.scheme != 'https' or parts.port not in (None, 443) or parts.username or parts.password:
            raise ValueError()
        if not any(host == domain or host.endswith('.'+domain) for domain in DOMAINS):
            raise ValueError()
    except ValueError:
        raise ImportProblem('仅支持腾讯文档 / 腾讯云 COS、飞书和钉钉的 HTTPS 链接，不支持本地地址或自定义端口') from None
    return parts


def public_addresses(host):
    infos = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not infos or any(not ipaddress.ip_address(v[4][0]).is_global for v in infos):
        raise ImportProblem('文档链接指向非公网地址，无法读取')
    return infos


class PinnedHTTPS(http.client.HTTPSConnection):
    def connect(self):
        # Pin DNS resolution for the connection; TLS still verifies the real hostname.
        last_error = None
        for family, kind, proto, _, address in public_addresses(self.host):
            sock = socket.socket(family, kind, proto)
            sock.settimeout(self.timeout)
            try:
                sock.connect(address)
                self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
                return
            except OSError as exc:
                sock.close()
                last_error = exc
        raise last_error


def fetch(url, headers=None):
    parts = checked_url(url)
    original_host = parts.hostname
    headers = headers or {}
    try:
        for _ in range(5):
            parts = checked_url(url)
            conn = PinnedHTTPS(parts.hostname, timeout=18, context=ssl.create_default_context())
            try:
                # Never forward credentials across hosts, including redirects to a CDN.
                current_headers = headers if parts.hostname == original_host else {}
                conn.request('GET', urlunsplit(('', '', parts.path or '/', parts.query, '')),
                             headers={'User-Agent': 'ProjectSpace-Importer/1.0', 'Accept-Encoding': 'identity', **current_headers})
                response = conn.getresponse()
                if response.status in (301, 302, 303, 307, 308):
                    url = urljoin(url, response.getheader('Location', ''))
                    continue
                if response.status != 200:
                    raise ImportProblem('文档读取失败（HTTP '+str(response.status)+'），请核对分享权限或授权信息')
                if response.getheader('Content-Encoding', 'identity') != 'identity':
                    raise ImportProblem('平台返回了不支持的压缩内容，请导出文件后导入')
                raw = response.read(MAX_REMOTE+1)
                if len(raw) > MAX_REMOTE:
                    raise ImportProblem('链接内容超过 4MB，请导出并拆分文件')
                return raw, response.getheader('Content-Type', ''), url
            finally:
                conn.close()
        raise ImportProblem('链接重定向次数过多，请使用最终的文档链接')
    except ImportProblem:
        raise
    except (OSError, ValueError, http.client.HTTPException):
        raise ImportProblem('无法连接文档平台或读取超时，请稍后重试或导出本地文件') from None


def api_json(url, headers):
    raw, _, _ = fetch(url, headers)
    try:
        data = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ImportProblem('平台未返回有效数据，请核对授权信息') from None
    if not isinstance(data, dict):
        raise ImportProblem('平台数据格式不支持')
    if data.get('code', 0) not in (0, '0', None) or data.get('ret', 0) != 0 or data.get('success') is False:
        # Do not relay platform error strings: they can include credentials or signed URLs.
        raise ImportProblem('平台拒绝读取文档，请核对令牌是否有效、文档权限及应用读取权限')
    return data


def cloud_rows(tables):
    rows, sheets = [], []
    for name, values in tables:
        rows.extend(table_rows(values, name))
        sheets.append(name)
    if not rows or len(rows) > MAX_ROWS:
        raise ImportProblem('未找到工作项或超过 2000 条，请拆分表格')
    return {'rows': rows, 'sheets': sheets, 'sourceProject': None}


def read_feishu(parts, auth):
    base = 'https://open.larksuite.com/open-apis' if 'larksuite.com' in parts.hostname else 'https://open.feishu.cn/open-apis'
    headers = {'Authorization': 'Bearer '+auth['token']}
    match = re.search(r'/(docx|docs|sheets|wiki)/([A-Za-z0-9_-]+)', parts.path)
    if not match:
        raise ImportProblem('请使用飞书文档、电子表格或知识库的完整链接')
    kind, token = match.groups()
    if kind == 'wiki':
        node = api_json(base+'/wiki/v2/spaces/get_node?'+urlencode({'token': token}), headers)['data']['node']
        kind, token = node['obj_type'], node['obj_token']
    if kind in ['docx', 'doc']:
        endpoint = '/docx/v1/documents/' if kind == 'docx' else '/doc/v2/'
        ending = '/raw_content'
        content = api_json(base+endpoint+quote(token, safe='')+ending, headers)['data']['content']
        return parse_document(content.encode(), '飞书文档.txt')
    if kind not in ['sheets', 'sheet']:
        raise ImportProblem('该飞书文档类型暂不支持，请导出为 XLSX 或 DOCX 后导入')
    sheets = api_json(base+'/sheets/v3/spreadsheets/'+token+'/sheets/query', headers)['data']['sheets']
    tables = []
    if len(sheets) > 30:
        raise ImportProblem('工作表超过 30 个，请拆分后导入')
    for sheet in sheets:
        grid = sheet.get('grid_properties', {})
        row_count, column_count = grid.get('row_count', 0), grid.get('column_count', 0)
        if not 1 <= row_count <= 10000 or not 1 <= column_count <= 256 or row_count*column_count > MAX_CELLS:
            raise ImportProblem('飞书工作表过大或缺少范围信息，请精简后导入')
        range_name = sheet['sheet_id']+'!A1:'+col_name(column_count)+str(row_count)
        data = api_json(base+'/sheets/v2/spreadsheets/'+token+'/values/'+quote(range_name, safe='')+'?valueRenderOption=ToString&dateTimeRenderOption=FormattedString', headers)
        values = data['data']['valueRange'].get('values', [])
        if any(any(text_value(v) for v in row) for row in values):
            tables.append((sheet.get('title', sheet['sheet_id']), values))
    return cloud_rows(tables)


def read_tencent(parts, auth):
    if not auth.get('clientId') or not auth.get('openId'):
        raise ImportProblem('腾讯文档授权读取需要 Access-Token、Client-Id 和 Open-Id')
    headers = {'Access-Token': auth['token'], 'Client-Id': auth['clientId'], 'Open-Id': auth['openId']}
    match = re.search(r'/(?:sheet|doc|slide)/([A-Za-z0-9_-]+)', parts.path)
    if not match:
        raise ImportProblem('请使用腾讯文档的完整表格或文档链接')
    data = api_json('https://docs.qq.com/openapi/drive/v2/util/converter?'+urlencode({'type': 2, 'value': match.group(1)}), headers)
    file_id = data['data']['fileID']
    exported = api_json('https://docs.qq.com/openapi/drive/v2/files/'+quote(file_id, safe='')+'/export', headers)
    raw, _, _ = fetch(exported['data']['url'])
    return parse_document(raw, '腾讯文档.xlsx')


def read_dingtalk(parts, auth):
    if not auth.get('operatorId'):
        raise ImportProblem('钉钉授权读取需要访问令牌和 operatorId（操作人标识）')
    workbook = auth.get('documentId', '')
    if not workbook:
        match = re.search(r'/(?:workbooks|sheets)/([A-Za-z0-9_-]+)', parts.path)
        workbook = match.group(1) if match else ''
    if not workbook:
        raise ImportProblem('钉钉分享链接不能直接确定工作簿，请在授权信息中填写 workbookId；普通文档请导出 DOCX 后导入')
    if not re.fullmatch(r'[A-Za-z0-9_.-]{1,200}', workbook):
        raise ImportProblem('钉钉 workbookId 格式无效')
    headers = {'x-acs-dingtalk-access-token': auth['token']}
    base = 'https://api.dingtalk.com/v1.0/doc/workbooks/'+quote(workbook, safe='')+'/sheets'
    query = '?'+urlencode({'operatorId': auth['operatorId']})
    sheets = api_json(base+query, headers).get('value', [])
    if len(sheets) > 30:
        raise ImportProblem('工作表超过 30 个，请拆分后导入')
    tables = []
    for sheet in sheets:
        path = base+'/'+quote(sheet['id'], safe='')
        metadata = api_json(path+query, headers)
        rows, columns = metadata.get('rowCount', 0), metadata.get('columnCount', 0)
        if not 1 <= rows <= 10000 or not 1 <= columns <= 256 or rows*columns > MAX_CELLS:
            raise ImportProblem('钉钉工作表过大或接口未提供完整范围，请导出 XLSX 后导入')
        data = api_json(path+'/ranges/'+quote('A1:'+col_name(columns)+str(rows), safe='')+query, headers)
        values = data.get('displayValues') or data.get('values') or []
        if any(any(text_value(v) for v in row) for row in values):
            tables.append((sheet.get('name', sheet['id']), values))
    return cloud_rows(tables)


def read_link(url, auth=None):
    parts = checked_url(url)
    auth = auth or {}
    for key in ['token', 'clientId', 'openId', 'operatorId', 'documentId']:
        if not isinstance(auth.get(key, ''), str) or len(auth.get(key, '')) > 4096 or re.search(r'[\r\n\x00]', auth.get(key, '')):
            raise ImportProblem('授权字段格式无效')
    try:
        if auth.get('token'):
            host = parts.hostname
            if host == 'docs.qq.com':
                data = read_tencent(parts, auth)
            elif any(host == d or host.endswith('.'+d) for d in ['feishu.cn', 'larksuite.com', 'larkoffice.com']):
                data = read_feishu(parts, auth)
            elif any(host == d or host.endswith('.'+d) for d in ['dingtalk.com', 'alidocs.com']):
                data = read_dingtalk(parts, auth)
            else:
                raise ImportProblem('该链接无需填写平台令牌，请使用公开或临时签名的下载链接')
        else:
            raw, content_type, final = fetch(url)
            name = urlsplit(final).path.rsplit('/', 1)[-1]
            if not re.search(r'\.(xlsx|csv|tsv|json|docx|txt|md|html?)$', name, re.I):
                name = '共享文档.html' if 'html' in content_type else '共享文档.json' if 'json' in content_type else '共享文档.xlsx' if raw.startswith(b'PK') else '共享文档'
            data = parse_document(raw, name)
        # Never store query strings (signed URLs/tokens) or fragments in import provenance.
        data['source'] = urlunsplit((parts.scheme, parts.netloc, parts.path, '', ''))
        return data
    except ImportProblem:
        raise
    except (KeyError, TypeError, ValueError):
        raise ImportProblem('平台返回的数据与预期不符，当前文档类型可能不支持，请导出文件后导入') from None
