import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aed_collector import Collector, atomic, boundary, catalogue, queue, sync, summary


GML = b'''<wfs:FeatureCollection xmlns:wfs="http://www.opengis.net/wfs/2.0"
 xmlns:ms="http://mapserver.gis.umn.edu/mapserver" xmlns:gml="http://www.opengis.net/gml/3.2"
 numberMatched="1" numberReturned="1"><wfs:member><ms:A03_Granice_gmin>
 <ms:JPT_KOD_JE>0461011</ms:JPT_KOD_JE><ms:JPT_NAZWA_>Bydgoszcz</ms:JPT_NAZWA_>
 <ms:msGeometry><gml:MultiSurface srsName="urn:ogc:def:crs:EPSG::4326">
 <gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
 <gml:posList srsDimension="2">53 17 53 19 54 19 54 17 53 17</gml:posList>
 </gml:LinearRing></gml:exterior><gml:interior><gml:LinearRing>
 <gml:posList>53.4 17.4 53.4 17.6 53.6 17.6 53.6 17.4 53.4 17.4</gml:posList>
 </gml:LinearRing></gml:interior></gml:Polygon></gml:surfaceMember>
 </gml:MultiSurface></ms:msGeometry></ms:A03_Granice_gmin></wfs:member></wfs:FeatureCollection>'''


def point(identifier, x, y):
    return {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [x, y]},
            'properties': {'@osm_type': 'node', '@osm_id': identifier, 'emergency': 'defibrillator'}}


class CollectorTests(unittest.TestCase):
    def test_boundary_axis_order_holes_and_identity(self):
        area = boundary(GML, '0461011')
        self.assertEqual(area['geometry']['coordinates'][0][0][0], [17, 53])
        self.assertEqual(len(area['geometry']['coordinates'][0]), 2)
        with self.assertRaises(ValueError):
            boundary(GML, '0463011')
        with self.assertRaises(ValueError):
            boundary(GML.replace(b'EPSG::4326', b'EPSG::2180'), '0461011')

    def test_catalogue_rejects_truncated_download(self):
        self.assertEqual(catalogue(GML)[0]['terc'], '0461011')
        with self.assertRaises(ValueError):
            catalogue(GML.replace(b'numberMatched="1"', b'numberMatched="2"'))

    def test_cut_and_resume_with_cached_official_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            rows = [{'terc': '0461011', 'name': 'Bydgoszcz'}, {'terc': '0403012', 'name': 'Biale Blota'}]
            atomic(folder / 'queue.json', rows)
            worker = Collector(folder)
            worker.points = [point(1, 18, 53.5), point(2, 17.5, 53.5), point(3, 20, 53.5)]
            worker.imported_at = '2026-11-21T11:00:00Z'
            worker.fingerprint = 'snapshot-test'
            sync(worker.db, rows)
            area = boundary(GML, '0461011')
            atomic(folder / 'results/0461011/boundary.geojson', area)
            with patch('aed_collector.download', side_effect=AssertionError('Cache must avoid network')):
                self.assertEqual(worker.process(rows[0]), 1)
                data = json.loads((folder / 'results/0461011/aed.normalized.geojson').read_text())
                identifier = data['features'][0]['id']
                self.assertEqual(data['features'][0]['properties']['location_city'], 'Bydgoszcz')
                self.assertEqual(worker.process(rows[0]), 1)
                self.assertEqual(json.loads((folder / 'results/0461011/aed.normalized.geojson').read_text())['features'][0]['id'], identifier)
            rural = json.loads(json.dumps(area))
            rural['properties']['JPT_KOD_JE'] = '0403012'
            rural['properties']['JPT_NAZWA_'] = 'Biale Blota'
            atomic(folder / 'results/0403012/boundary.geojson', rural)
            worker.process(rows[1])
            rural_record = json.loads((folder / 'results/0403012/aed.normalized.geojson').read_text())['features'][0]
            self.assertIsNone(rural_record['properties']['location_city'])
            self.assertEqual(rural_record['id'], identifier)
            worker.db.execute("UPDATE jobs SET status='done',record_count=1 WHERE terc='0461011'")
            worker.db.commit()
            worker.db.close()
            resumed = Collector(folder)
            self.assertEqual(summary(resumed.db, rows)['done'], 1)
            resumed.db.close()

    def test_queue_can_be_reordered_and_disabled(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            rows = [{'terc': '0463011', 'name': 'Torun'}, {'terc': '0461011', 'name': 'Bydgoszcz', 'enabled': False}]
            atomic(folder / 'queue.json', rows)
            self.assertEqual([r['terc'] for r in queue(folder)], ['0463011'])
            atomic(folder / 'queue.json', rows + [rows[0]])
            with self.assertRaises(ValueError):
                queue(folder)

    def test_failure_is_retried_then_does_not_disappear(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            atomic(folder / 'queue.json', [{'terc': '0461011', 'name': 'Bydgoszcz'}])
            atomic(folder / 'config.json', {'snapshot': 'unused', 'max_attempts': 2})
            worker = Collector(folder)
            with self.assertLogs(level='ERROR'), patch.object(worker, 'inputs'), patch.object(worker, 'process', side_effect=OSError('upstream offline')):
                worker.run(limit=1)
            resumed = Collector(folder)
            job = dict(resumed.db.execute('SELECT * FROM jobs').fetchone())
            self.assertEqual(job['status'], 'retry')
            self.assertEqual(job['failures'], 1)
            resumed.db.execute('UPDATE jobs SET next_try=0')
            resumed.db.commit()
            resumed.db.close()
            worker = Collector(folder)
            with self.assertLogs(level='ERROR'), patch.object(worker, 'inputs'), patch.object(worker, 'process', side_effect=OSError('upstream offline')):
                worker.run(limit=1)
            resumed = Collector(folder)
            self.assertEqual(dict(resumed.db.execute('SELECT * FROM jobs').fetchone())['status'], 'failed')
            resumed.db.close()


if __name__ == '__main__':
    unittest.main()
