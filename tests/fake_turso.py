"""Local SQL-over-HTTP fixture exercising the official driver's transaction protocol."""
import base64
import json
import sqlite3
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def encode(value):
    if value is None:
        return {'type':'null'}
    if isinstance(value, bytes):
        return {'type':'blob','base64':base64.b64encode(value).decode()}
    if isinstance(value, int):
        return {'type':'integer','value':str(value)}
    if isinstance(value, float):
        return {'type':'float','value':value}
    return {'type':'text','value':value}


def decode(value):
    kind=value['type']
    if kind=='null': return None
    if kind=='integer': return int(value['value'])
    if kind=='float': return value['value']
    if kind=='blob': return base64.b64decode(value['base64'])
    return value['value']


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def do_POST(self):
        if self.headers.get('Authorization') != 'Bearer fixture-token':
            self.send_error(401)
            return
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        baton=body.get('baton')
        if not baton:
            baton=uuid.uuid4().hex
            self.server.streams[baton]=sqlite3.connect(self.server.path,check_same_thread=False,isolation_level=None,timeout=15)
        connection=self.server.streams[baton]
        if self.path=='/v3/cursor':
            lines=[{'baton':baton,'base_url':None}]
            statement=body['batch']['steps'][0]['stmt']
            try:
                cursor=connection.execute(statement['sql'],[decode(v) for v in statement.get('args',[])])
                lines.append({'type':'step_begin','step':0,'cols':[{'name':v[0]} for v in cursor.description or []]})
                for row in cursor.fetchall():
                    lines.append({'type':'row','row':[encode(v) for v in row]})
                lines.append({'type':'step_end','affected_row_count':max(cursor.rowcount,0),'last_insert_rowid':str(cursor.lastrowid) if cursor.lastrowid is not None else None})
            except sqlite3.Error as exc:
                lines.append({'type':'step_error','step':0,'error':{'code':'SQLITE_CONSTRAINT' if isinstance(exc,sqlite3.IntegrityError) else 'SQLITE_ERROR','message':str(exc)}})
            if not connection.in_transaction:
                lines.extend([{'type':'step_begin','step':1,'cols':[]},{'type':'step_end','affected_row_count':0}])
            raw=('\n'.join(json.dumps(v) for v in lines)+'\n').encode()
        elif self.path=='/v3/pipeline':
            results=[]
            for request in body['requests']:
                kind=request['type']
                if kind=='sequence': connection.executescript(request['sql']);response={'type':'sequence'}
                elif kind=='get_autocommit': response={'type':'get_autocommit','is_autocommit':not connection.in_transaction}
                elif kind=='close': connection.close();self.server.streams.pop(baton);response={'type':'close'}
                else: raise AssertionError(kind)
                results.append({'type':'ok','response':response})
            raw=json.dumps({'baton':baton,'base_url':None,'results':results}).encode()
        else:
            self.send_error(404)
            return
        self.send_response(200);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)


class Provider:
    def __init__(self,path):
        self.http=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.http.path=str(path);self.http.streams={}
        self.base='http://127.0.0.1:'+str(self.http.server_port)
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()

    def close(self):
        self.http.shutdown();self.http.server_close()
        for connection in self.http.streams.values(): connection.close()
