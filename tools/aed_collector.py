"""Sequential, resumable AED municipality collector (Python standard library).

Commands: init, run, start, stop, status, retry-failed.
Edit collector/queue.json to reorder or disable municipalities while running.
Downloads PRG boundaries one at a time and cuts AED records from one cached
national OSM export. This does not discover or import other municipal APIs.
"""

import argparse
import fcntl
import hashlib
import json
import logging
import os
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

from build_bydgoszcz_pilot import covers, fetched_at, normalize_osm, valid_point

ROOT = Path(__file__).resolve().parents[1]
BASE = 'https://mapy.geoportal.gov.pl/wss/service/PZGIK/PRG/WFS/AdministrativeBoundaries'
LAYER = 'ms:A03_Granice_gmin'
NS = {'ms': 'http://mapserver.gis.umn.edu/mapserver', 'gml': 'http://www.opengis.net/gml/3.2'}
UNIT = 'blisko-aed-collector.service'
ATTRIBUTION = {'name': 'ODbL-1.0', 'url': 'https://opendatacommons.org/licenses/odbl/1-0/',
               'attribution': '© OpenStreetMap contributors'}


def utc():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def load(path):
    return json.loads(Path(path).read_text())


def atomic(path, value):
    """Publish complete files only, including after a crash or interrupted write."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    pretty = 2 if path.name in ('queue.json', 'config.json', 'status.json') else None
    body = value if isinstance(value, bytes) else (json.dumps(value, ensure_ascii=False, indent=pretty) + '\n').encode('utf-8')
    with temp.open('wb') as f:
        f.write(body)
        f.flush()
        os.fsync(f.fileno())
    temp.replace(path)


def url(params):
    return BASE + '?' + urllib.parse.urlencode({
        'service': 'WFS', 'version': '2.0.0', 'request': 'GetFeature',
        'typeNames': LAYER, **params})


def download(target):
    request = urllib.request.Request(target, headers={'User-Agent': 'BliskoAED-Collector/0.1 (PRG municipality data import)'})
    with urllib.request.urlopen(request, timeout=45) as response:
        body = response.read(40_000_001)
        if len(body) > 40_000_000:
            raise ValueError('PRG response exceeds 40 MB limit')
        return body


def features(body):
    root = ET.fromstring(body)
    if root.tag.rsplit('}', 1)[-1] != 'FeatureCollection':
        raise ValueError('PRG returned an error instead of a FeatureCollection: ' + ''.join(root.itertext())[:300])
    return root, root.findall('.//ms:A03_Granice_gmin', NS)


def catalogue(body):
    root, rows = features(body)
    if int(root.attrib['numberMatched']) != len(rows):
        raise ValueError('Incomplete municipality catalogue; pagination is required')
    result = []
    for row in rows:
        code = row.findtext('ms:JPT_KOD_JE', namespaces=NS)
        name = row.findtext('ms:JPT_NAZWA_', namespaces=NS)
        if not re.fullmatch(r'\d{7}', code or '') or not name:
            raise ValueError('Missing municipality code or name')
        result.append({'terc': code, 'name': name, 'enabled': True})
    if len({row['terc'] for row in result}) != len(result):
        raise ValueError('Duplicate municipality codes')
    return result


def boundary(body, code):
    _, rows = features(body)
    if len(rows) != 1 or rows[0].findtext('ms:JPT_KOD_JE', namespaces=NS) != code:
        raise ValueError('PRG response does not match the requested municipality')
    row = rows[0]
    parents = {child: parent for parent in row.iter() for child in parent}
    polygons = []
    for poly in row.findall('.//gml:Polygon', NS):
        # WFS 2 + EPSG:4326 uses latitude,longitude axis order.
        element = poly
        while element is not None and 'srsName' not in element.attrib:
            element = parents.get(element)
        if element is None or element.attrib['srsName'] != 'urn:ogc:def:crs:EPSG::4326':
            raise ValueError('Unexpected coordinate reference system')
        rings = []
        for kind in ['exterior', 'interior']:
            for ring in poly.findall('gml:' + kind + '/gml:LinearRing', NS):
                pos = ring.find('gml:posList', NS)
                if pos is None or pos.attrib.get('srsDimension', '2') != '2':
                    raise ValueError('Expected two-dimensional GML posList')
                numbers = list(map(float, pos.text.split()))
                if len(numbers) % 2:
                    raise ValueError('Odd GML coordinate count')
                coords = [[numbers[i + 1], numbers[i]] for i in range(0, len(numbers), 2)]
                if len(coords) < 4 or coords[0] != coords[-1]:
                    raise ValueError('Unclosed polygon ring')
                if not all(13 < x < 25 and 48 < y < 56 for x, y in coords):
                    raise ValueError('Coordinates outside Poland; check GML axis order')
                rings.append(coords)
        if not rings:
            raise ValueError('Empty polygon')
        polygons.append(rings)
    if not polygons:
        raise ValueError('No polygon geometry in PRG response')
    props = {e.tag.rsplit('}', 1)[-1]: e.text for e in row if e.tag.startswith('{' + NS['ms'] + '}') and len(e) == 0}
    return {'type': 'Feature', 'properties': props,
            'geometry': {'type': 'MultiPolygon', 'coordinates': polygons},
            'source': {'url': BASE, 'layer': LAYER, 'fetched_at': utc(),
                       'response_sha256': hashlib.sha256(body).hexdigest()}}


def database(directory):
    connection = sqlite3.connect(directory / 'progress.sqlite3', timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA journal_mode=WAL')
    connection.executescript('''
        CREATE TABLE IF NOT EXISTS jobs (
            terc TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
            failures INTEGER NOT NULL DEFAULT 0, next_try REAL NOT NULL DEFAULT 0,
            record_count INTEGER, last_error TEXT, updated_at TEXT);
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    ''')
    return connection


def queue(directory):
    rows = load(directory / 'queue.json')
    codes = set()
    for row in rows:
        if not re.fullmatch(r'\d{7}', row.get('terc', '')) or not isinstance(row.get('name'), str) or not row['name']:
            raise ValueError('Each queue entry needs a 7-digit terc and a name')
        if row['terc'] in codes:
            raise ValueError('Duplicate queue entry: ' + row['terc'])
        codes.add(row['terc'])
    return [r for r in rows if r.get('enabled', True)]


def sync(db, rows):
    with db:
        for row in rows:
            db.execute('INSERT INTO jobs(terc,name) VALUES (?,?) ON CONFLICT(terc) DO UPDATE SET name=excluded.name', (row['terc'], row['name']))


def summary(db, rows):
    jobs = {r['terc']: dict(r) for r in db.execute('SELECT * FROM jobs')}
    counts = dict.fromkeys(['pending', 'running', 'done', 'retry', 'failed'], 0)
    records = 0
    for row in rows:
        job = jobs.get(row['terc'], {'status': 'pending'})
        counts[job['status']] += 1
        if job['status'] == 'done':
            records += job.get('record_count') or 0
    return {'total': len(rows), **counts, 'record_assignments': records}


class Collector:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.db = database(self.directory)
        self.stop = threading.Event()
        self.snapshot = None
        self.fingerprint = None
        self.points = None
        self.imported_at = None

    def inputs(self, config):
        path = (ROOT / config['snapshot']).resolve()
        if self.snapshot == path:
            return
        content = path.read_bytes()
        sha = hashlib.sha256(content).hexdigest()
        data = json.loads(content)
        if data.get('type') != 'FeatureCollection' or not all(valid_point(f) for f in data['features']):
            raise ValueError('National AED snapshot contains invalid point geometries')
        self.points = data['features']
        self.snapshot, self.fingerprint, self.imported_at = path, sha, fetched_at(path)
        previous = self.db.execute("SELECT value FROM meta WHERE key='snapshot_sha256'").fetchone()
        with self.db:
            if previous and previous[0] != sha:
                self.db.execute("UPDATE jobs SET status='pending',failures=0,next_try=0,last_error=NULL")
            self.db.execute("INSERT OR REPLACE INTO meta VALUES ('snapshot_sha256',?)", (sha,))

    def state(self, phase, rows, current=None):
        value = {'phase': phase, 'pid': os.getpid(), 'updated_at': utc(),
                 'progress': summary(self.db, rows), 'current': current,
                 'snapshot_sha256': self.fingerprint}
        atomic(self.directory / 'status.json', value)
        return value

    def process(self, job):
        target = self.directory / 'results' / job['terc']
        cache = target / 'boundary.geojson'
        if cache.exists():
            area = load(cache)
            if area['properties']['JPT_KOD_JE'] != job['terc']:
                raise ValueError('Wrong municipality in cached boundary')
        else:
            filter_xml = ('<Filter xmlns="http://www.opengis.net/fes/2.0"><PropertyIsEqualTo>'
                          '<ValueReference>JPT_KOD_JE</ValueReference><Literal>' + job['terc'] +
                          '</Literal></PropertyIsEqualTo></Filter>')
            area = boundary(download(url({'srsName': 'urn:ogc:def:crs:EPSG::4326', 'count': 2, 'filter': filter_xml})), job['terc'])
            atomic(cache, area)
        polygons = area['geometry']['coordinates']
        vertices = [point for poly in polygons for point in poly[0]]
        west, east = min(p[0] for p in vertices), max(p[0] for p in vertices)
        south, north = min(p[1] for p in vertices), max(p[1] for p in vertices)
        selected = [f for f in self.points
                    if west <= f['geometry']['coordinates'][0] <= east
                    and south <= f['geometry']['coordinates'][1] <= north
                    and covers(f['geometry']['coordinates'], area['geometry'])]
        name = area['properties']['JPT_NAZWA_']
        # A rural or mixed municipality is not itself a city/address locality.
        city = name if job['terc'].endswith('1') else None
        normalized = [normalize_osm(f, self.imported_at, city=city) for f in selected]
        if len({f['id'] for f in normalized}) != len(normalized):
            raise ValueError('Duplicate source IDs in national snapshot')
        common = {'type': 'FeatureCollection', 'license': ATTRIBUTION,
                  'administrative_area': {'country': 'PL', 'gmina': name, 'terc': job['terc'], 'boundary_source': BASE},
                  'snapshot_sha256': self.fingerprint}
        atomic(target / 'aed.raw.geojson', {**common, 'features': selected})
        atomic(target / 'aed.normalized.geojson', {**common, 'features': normalized})
        atomic(target / 'manifest.json', {'status': 'complete', 'terc': job['terc'], 'name': name,
                                         'records': len(selected), 'completed_at': utc(),
                                         'snapshot_sha256': self.fingerprint,
                                         'notes': ['Source is OSM, boundary is PRG; no independent municipal AED APIs are imported.',
                                                   'A point on a shared boundary can belong to two partitions; global IDs remain the same.',
                                                   'Missing locality in a rural or mixed municipality remains null.']})
        return len(selected)

    def run(self, limit=None):
        lock = (self.directory / 'worker.lock').open('a')
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('A collector is already running')
        with self.db:
            self.db.execute("UPDATE jobs SET status='pending' WHERE status='running'")
        handled, rows = 0, []
        try:
            while not self.stop.is_set():
                config = load(self.directory / 'config.json')
                rows = queue(self.directory)
                sync(self.db, rows)
                self.inputs(config)
                jobs = {r['terc']: dict(r) for r in self.db.execute('SELECT * FROM jobs')}
                job = next((jobs[r['terc']] for r in rows if jobs[r['terc']]['status'] in ('pending', 'retry') and jobs[r['terc']]['next_try'] <= time.time()), None)
                if job is None:
                    if any(jobs[r['terc']]['status'] == 'retry' for r in rows):
                        self.state('waiting_for_retry', rows)
                        self.stop.wait(5)
                        continue
                    self.state('finished', rows)
                    return
                with self.db:
                    self.db.execute("UPDATE jobs SET status='running',updated_at=? WHERE terc=?", (utc(), job['terc']))
                self.state('running', rows, {'terc': job['terc'], 'name': job['name']})
                try:
                    count = self.process(job)
                    with self.db:
                        self.db.execute("UPDATE jobs SET status='done',record_count=?,last_error=NULL,updated_at=? WHERE terc=?", (count, utc(), job['terc']))
                    logging.info('DONE %s %s: %d AED records', job['terc'], job['name'], count)
                except Exception as error:
                    failures = job['failures'] + 1
                    retry = failures < int(config.get('max_attempts', 4))
                    delay = min(900, 60 * 2 ** (failures - 1))
                    retry_after = (getattr(error, 'headers', {}) or {}).get('Retry-After', '')
                    if retry_after.isdigit():
                        delay = max(delay, min(86400, int(retry_after)))
                    with self.db:
                        self.db.execute('UPDATE jobs SET status=?,failures=?,next_try=?,last_error=?,updated_at=? WHERE terc=?',
                                        ('retry' if retry else 'failed', failures, time.time() + delay, str(error)[:1000], utc(), job['terc']))
                    logging.exception('ERROR %s %s', job['terc'], job['name'])
                handled += 1
                self.state('running', rows)
                if limit and handled >= limit:
                    break
                self.stop.wait(max(1, float(config.get('interval_seconds', 10))))
            self.state('stopped', rows)
        finally:
            lock.close()
            self.db.close()


def initialize(directory, source=None):
    directory.mkdir(parents=True, exist_ok=True)
    if (directory / 'queue.json').exists():
        raise SystemExit('Queue already exists; edit it or resume with start')
    body = Path(source).read_bytes() if source else download(url({'propertyName': 'JPT_KOD_JE,JPT_NAZWA_', 'count': 5000}))
    rows = catalogue(body)
    priority = ['Bydgoszcz', 'Toruń', 'Warszawa', 'Gdańsk', 'Poznań', 'Kraków', 'Wrocław', 'Łódź', 'Szczecin', 'Lublin', 'Białystok', 'Katowice', 'Olsztyn', 'Kielce', 'Rzeszów', 'Opole', 'Gorzów Wielkopolski', 'Zielona Góra']
    def rank(row):
        first = priority.index(row['name']) if row['name'] in priority and row['terc'].endswith('1') else len(priority)
        return first, row['name'].casefold(), row['terc']
    rows.sort(key=rank)
    snapshots = sorted((ROOT / 'data-model/snapshots').glob('osm-poland-*.geojson'))
    if not snapshots:
        raise SystemExit('Download a national OSM AED snapshot into data-model/snapshots first')
    atomic(directory / 'catalogue.gml', body)
    atomic(directory / 'queue.json', rows)
    atomic(directory / 'config.json', {'snapshot': str(snapshots[-1].relative_to(ROOT)), 'interval_seconds': 10, 'max_attempts': 4})
    print(json.dumps({'queued': len(rows), 'first': rows[:3]}, ensure_ascii=False, indent=2))


def service(action, directory):
    if action == 'stop':
        subprocess.run(['systemctl', '--user', 'stop', UNIT], check=True)
        return
    active = subprocess.run(['systemctl', '--user', 'is-active', UNIT], capture_output=True, text=True)
    if active.stdout.strip() in ('active', 'activating'):
        print('Collector is already running')
        return
    subprocess.run(['systemd-run', '--user', '--collect', '--unit=' + UNIT,
                    '--description=Blisko AED sequential municipality collector',
                    '--property=Restart=on-failure', '--property=RestartSec=15',
                    '--property=TimeoutStopSec=60', '--property=Nice=10',
                    '--property=StandardOutput=append:' + str(directory / 'worker.log'),
                    '--property=StandardError=append:' + str(directory / 'worker.log'),
                    '--working-directory=' + str(ROOT),
                    sys.executable, str(Path(__file__).resolve()), '--directory', str(directory), 'run'], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'collector')
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init'); init.add_argument('--catalogue-file')
    run = sub.add_parser('run'); run.add_argument('--limit', type=int)
    for name in ['start', 'stop', 'status', 'retry-failed']:
        sub.add_parser(name)
    args = parser.parse_args()
    directory = args.directory.resolve()
    if args.command == 'init':
        initialize(directory, args.catalogue_file)
    elif args.command in ('start', 'stop'):
        if not (directory / 'queue.json').exists():
            raise SystemExit('Run init first')
        service(args.command, directory)
    elif args.command == 'status':
        db = database(directory)
        state = load(directory / 'status.json') if (directory / 'status.json').exists() else {'phase': 'not_started'}
        state['progress'] = summary(db, queue(directory))
        state['recent_errors'] = [dict(r) for r in db.execute("SELECT terc,name,status,last_error FROM jobs WHERE last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 5")]
        manager = subprocess.run(['systemctl', '--user', 'is-active', UNIT], capture_output=True, text=True)
        state['service'] = manager.stdout.strip() or 'unavailable'
        print(json.dumps(state, ensure_ascii=False, indent=2))
        db.close()
    elif args.command == 'retry-failed':
        db = database(directory)
        with db:
            result = db.execute("UPDATE jobs SET status='pending',failures=0,next_try=0 WHERE status='failed'")
        print('Reset failed jobs:', result.rowcount)
        db.close()
    else:
        logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
        worker = Collector(directory)
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: worker.stop.set())
        worker.run(args.limit)


if __name__ == '__main__':
    main()
