"""Verify the hosted API before exposing its address on the GitHub Pages portal."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
import urllib.request


def validate_url(value):
    parts = urlsplit(value)
    if (parts.scheme != 'https' or not parts.hostname or parts.port not in [None, 443]
            or parts.username or parts.password or parts.query or parts.fragment
            or parts.path not in ['', '/'] or parts.hostname in ['localhost', '127.0.0.1', '::1']):
        raise ValueError('请使用云服务的 HTTPS 根地址，不带账号、路径、参数或片段')
    return 'https://' + parts.netloc


def configure(value, root=None):
    public_url = validate_url(value)
    # A working landing page is insufficient: verify the actual database-backed API.
    with urllib.request.urlopen(public_url+'/api/health', timeout=25) as response:
        if response.status != 200 or json.load(response).get('ok') is not True:
            raise ValueError('云端数据库服务尚未就绪，未修改访问入口')
    path = (root or Path(__file__).resolve().parent.parent) / 'docs' / 'config.json'
    path.write_text(json.dumps({'appUrl': public_url}, ensure_ascii=False, indent=2)+'\n')
    return public_url


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='云端服务就绪后连接 GitHub 访问入口')
    parser.add_argument('url')
    args = parser.parse_args()
    try:
        print('云服务检查通过，访问入口已配置：'+configure(args.url))
    except Exception:
        raise SystemExit('连接失败：请检查 HTTPS 地址及 /api/health 是否已就绪。入口配置未更改。') from None
