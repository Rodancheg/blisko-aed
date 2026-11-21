"""Build a local Bydgoszcz pilot from downloaded files; no network requests.

python3 tools/build_bydgoszcz_pilot.py --poland FILE --boundary FILE --municipal-kml FILE
The boundary input is a cached Nominatim search response for Bydgoszcz.
Municipal entries without coordinates remain in staging and are never assigned
coordinates from the city centre or an unrelated OSM point.
"""

import argparse
import hashlib
import json
import math
import re
import uuid
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path


def read_json(path):
    return json.loads(Path(path).read_text())


def fetched_at(path):
    return datetime.fromtimestamp(Path(path).stat().st_mtime, timezone.utc).isoformat().replace('+00:00', 'Z')


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def ring_position(point, ring):
    """Return outside=0, inside=1, boundary=2 for a closed geographic ring."""
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        ax, ay = a[:2]
        bx, by = b[:2]
        cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax)
        if abs(cross) <= 1e-12 and min(ax, bx) <= x <= max(ax, bx) and min(ay, by) <= y <= max(ay, by):
            return 2
        if (ay > y) != (by > y) and x < ax + (y - ay) * (bx - ax) / (by - ay):
            inside = not inside
    return int(inside)


def covers(point, geometry):
    if geometry['type'] not in ('Polygon', 'MultiPolygon'):
        raise ValueError('An administrative Polygon or MultiPolygon is required')
    polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
    for rings in polygons:
        outer = ring_position(point, rings[0])
        holes = [ring_position(point, ring) for ring in rings[1:]]
        if outer == 2 or (outer == 1 and (2 in holes or 1 not in holes)):
            return True
    return False


def valid_point(feature):
    g = feature.get('geometry') or {}
    c = g.get('coordinates')
    return (g.get('type') == 'Point' and isinstance(c, list) and len(c) == 2
            and all(type(n) in (int, float) and math.isfinite(n) for n in c)
            and -180 <= c[0] <= 180 and -90 <= c[1] <= 90)


def common_record(source_id, source_record_id, coordinates, properties, imported_at):
    fields = ['defibrillator_id', 'device_access_description', 'device_availability',
              'device_location', 'device_manufacturer', 'device_public_access',
              'device_specifications', 'location_building', 'location_city',
              'location_description', 'location_object_name', 'location_postcode',
              'location_street', 'opening_hours']
    p = dict.fromkeys(fields)
    p.update(properties)
    p.update(opening_hours_timezone='Europe/Warsaw', device_operational_status='unknown')
    return {
        'type': 'Feature', 'id': str(uuid.uuid5(uuid.NAMESPACE_URL, source_id + '/' + source_record_id)),
        'schema_version': '0.1.0',
        'geometry': {'type': 'Point', 'coordinates': coordinates},
        'properties': p,
        'provenance': [{'source_id': source_id, 'source_record_id': source_record_id,
                        'source_updated_at': None, 'imported_at': imported_at}],
        'verification': {'status': 'unverified', 'last_verified_at': None},
    }


def normalize_osm(feature, imported_at, city='Bydgoszcz'):
    t = feature['properties']
    source_record_id = str(t['@osm_type']) + '/' + str(t['@osm_id'])
    hours = t.get('opening_hours')
    return common_record('osm.pl.aed', source_record_id, feature['geometry']['coordinates'], {
        'defibrillator_id': source_record_id,
        'device_access_description': hours,
        'device_location': {'yes': 'Wewnątrz budynku', 'no': 'Na zewnątrz budynku'}.get(t.get('indoor')),
        'device_manufacturer': t.get('manufacturer'),
        'device_public_access': t.get('access'),
        'location_city': t.get('addr:city') or city,
        'location_street': t.get('addr:street'),
        'location_building': t.get('addr:housenumber'),
        'location_postcode': t.get('addr:postcode'),
        'location_description': t.get('defibrillator:location:pl') or t.get('defibrillator:location') or t.get('description'),
        'location_object_name': t.get('name') or t.get('operator') or 'Defibrylator AED',
        # Other schedules remain verbatim in device_access_description until validated.
        'opening_hours': '24/7' if hours == '24/7' else None,
    }, imported_at)


def municipal_entries(path):
    ns = {'k': 'http://www.opengis.net/kml/2.2'}
    root = ET.parse(path).getroot()
    folders = [f for f in root.findall('.//k:Folder', ns) if f.findtext('k:name', namespaces=ns) == 'AED']
    if len(folders) != 1:
        raise ValueError('Expected exactly one municipal AED folder')
    rows = []
    for mark in folders[0].findall('k:Placemark', ns):
        data = {e.attrib['name']: e.findtext('k:value', namespaces=ns) for e in mark.findall('k:ExtendedData/k:Data', ns)}
        identifier = data.get('NR', '')
        if re.fullmatch(r'\d+\.0', identifier):
            identifier = identifier[:-2]
        if not identifier:
            raise ValueError('Municipal entry is missing its NR identifier')
        text = mark.findtext('k:Point/k:coordinates', namespaces=ns)
        coords = [float(n) for n in text.strip().split(',')[:2]] if text else None
        row = {'source_record_id': identifier, 'name': mark.findtext('k:name', namespaces=ns),
               'address': mark.findtext('k:address', namespaces=ns),
               'institution': data.get('INSTYTUCJA'), 'description_html': mark.findtext('k:description', namespaces=ns),
               'coordinates': coords, 'status': 'has_coordinates' if coords else 'needs_coordinates'}
        if coords and not valid_point({'geometry': {'type': 'Point', 'coordinates': coords}}):
            raise ValueError('Invalid coordinates in municipal entry ' + identifier)
        rows.append(row)
    if len({r['source_record_id'] for r in rows}) != len(rows):
        raise ValueError('Duplicate municipal source IDs')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--poland', required=True)
    parser.add_argument('--boundary', required=True)
    parser.add_argument('--municipal-kml', required=True)
    parser.add_argument('--out', type=Path, default=Path(__file__).resolve().parents[1] / 'data-model/pilots/bydgoszcz')
    args = parser.parse_args()
    country = read_json(args.poland)
    boundary = read_json(args.boundary)[0]
    if boundary.get('name') != 'Bydgoszcz' or boundary.get('type') != 'administrative':
        raise ValueError('The cached boundary must identify administrative Bydgoszcz')
    geometry = boundary['geojson']
    area = {'country': 'PL', 'voivodeship': 'kujawsko-pomorskie', 'gmina': 'Bydgoszcz',
            'gmina_type': 'miejska', 'terc': '0461011',
            'terc_reference': 'https://bdl.stat.gov.pl/bdl/dane/teryt/jednostka/933',
            'boundary_source': 'https://www.openstreetmap.org/relation/' + str(boundary['osm_id']),
            'boundary_admin_level': boundary.get('extratags', {}).get('admin_level'),
            'note': 'Pilot uses the OSM city/powiat boundary, coextensive with the city municipality; the 7-digit gmina TERC comes from GUS, not from the 4-digit OSM powiat tag.'}
    south, north, west, east = map(float, boundary['boundingbox'])
    candidates, selected, invalid = [], [], 0
    for feature in country['features']:
        if not valid_point(feature):
            invalid += 1
            continue
        x, y = feature['geometry']['coordinates']
        if west <= x <= east and south <= y <= north:
            candidates.append(feature)
            if covers([x, y], geometry):
                selected.append(feature)
    normalized = [normalize_osm(f, fetched_at(args.poland)) for f in selected]
    if len({f['id'] for f in normalized}) != len(normalized):
        raise ValueError('Duplicate OSM IDs in selected records')
    osm_license = {'name': 'ODbL-1.0', 'url': 'https://opendatacommons.org/licenses/odbl/1-0/',
                   'attribution': '© OpenStreetMap contributors'}
    meta = {'administrative_area': area, 'license': osm_license, 'imported_at': fetched_at(args.poland)}
    save(args.out / 'boundary.geojson', {'type': 'Feature', 'properties': area, 'geometry': geometry})
    save(args.out / 'osm.raw.geojson', {'type': 'FeatureCollection', **meta, 'features': selected})
    save(args.out / 'osm.normalized.geojson', {'type': 'FeatureCollection', **meta, 'features': normalized})

    staged = municipal_entries(args.municipal_kml)
    municipal = []
    for row in staged:
        if row['coordinates'] is None or not covers(row['coordinates'], geometry):
            continue
        address = row['address'] or row['name'] or ''
        match = re.fullmatch(r'Bydgoszcz\s+ul\.\s*(.+?)\s+(\d+[\w/-]*)', address.strip())
        municipal.append(common_record('pl.bydgoszcz.city.aed', row['source_record_id'], row['coordinates'], {
            'defibrillator_id': row['source_record_id'], 'location_city': 'Bydgoszcz',
            'location_object_name': (row['institution'] or '').strip() or 'Defibrylator AED',
            'location_street': match[1] if match else None,
            'location_building': match[2] if match else None,
        }, fetched_at(args.municipal_kml)))
    municipal_meta = {'source_id': 'pl.bydgoszcz.city.aed', 'publication_status': 'pending_license_confirmation',
                      'administrative_area': area, 'imported_at': fetched_at(args.municipal_kml)}
    save(args.out / 'municipal.staging.json', {**municipal_meta, 'records': staged})
    save(args.out / 'municipal.normalized.geojson', {'type': 'FeatureCollection', **municipal_meta, 'features': municipal})
    report = {'status': 'pilot', 'administrative_area': area,
              'poland_snapshot_records': len(country['features']),
              'poland_invalid_or_nonpoint_records': invalid,
              'bbox_candidates': len(candidates), 'inside_city_boundary': len(selected),
              'bbox_candidates_outside_city': len(candidates) - len(selected),
              'osm_missing_name_and_operator': sum(not f['properties'].get('name') and not f['properties'].get('operator') for f in selected),
              'osm_missing_address_street': sum(not f['properties'].get('addr:street') for f in selected),
              'osm_with_opening_hours': sum(bool(f['properties'].get('opening_hours')) for f in selected),
              'osm_access_values': dict(Counter(f['properties'].get('access', 'unknown') for f in selected)),
              'municipal_aed_records': len(staged),
              'municipal_with_coordinates': sum(r['coordinates'] is not None for r in staged),
              'municipal_needs_coordinates': sum(r['coordinates'] is None for r in staged),
              'municipal_normalized_inside_city': len(municipal),
              'snapshot_sha256': hashlib.sha256(Path(args.poland).read_bytes()).hexdigest(),
              'mapping_notes': [
                  'All selected raw OSM tags are preserved in osm.raw.geojson, including operator, level, check_date, images and fixme.',
                  'location_city is resolved spatially. Address fields are never guessed from an institution name or a nearby point.',
                  'name falls back to operator and then a generic AED label; the fallback is not a verified building name.',
                  'device_availability and device_specifications remain null: OSM access is not an equivalent of those Warsaw fields.',
                  'Only literal 24/7 is accepted as normalized opening_hours; other original expressions await validation.',
                  'Municipal KML includes non-AED layers, excluded by selecting only folder AED.',
                  'Records without coordinates remain in staging. No reverse geocoding, matching or deduplication has been performed.',
                  'The municipal source is kept separate pending confirmation of reuse terms. It is not attributed to OSM.',
                  'Counts are records in downloaded sources, not a verified count of physical devices or complete city coverage.',
                  'For nationwide production grouping, use versioned official PRG boundaries and retain unresolved or boundary-ambiguous records.'
              ]}
    save(args.out / 'inspection.json', report)
    print(json.dumps({k:v for k,v in report.items() if k not in ('mapping_notes', 'administrative_area')}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
