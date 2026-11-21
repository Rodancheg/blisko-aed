#!/usr/bin/env python3
"""Read a bounded CSV/XLSX/JSON upload for the data hub; no external services."""
import base64, csv, io, json, sys, zipfile
from pathlib import PurePosixPath
from xml.etree import ElementTree as ET
MAX_ROWS=25000
NS={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

def xlsx(data, requested=None):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if sum(entry.file_size for entry in archive.infolist())>60000000:raise ValueError('Arkusz jest zbyt duży po rozpakowaniu.')
        strings=[]
        if 'xl/sharedStrings.xml' in archive.namelist():
            tree=ET.fromstring(archive.read('xl/sharedStrings.xml'))
            strings=[''.join(item.itertext()) for item in tree.findall('s:si',NS)]
        workbook=ET.fromstring(archive.read('xl/workbook.xml'))
        relations=ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
        targets={item.get('Id'):item.get('Target') for item in relations}
        sheets=workbook.findall('s:sheets/s:sheet',NS)
        sheet=next((item for item in sheets if item.get('name')==requested),None) if requested else sheets[0]
        if sheet is None:raise ValueError('Nie znaleziono arkusza.')
        target=targets[sheet.get('{'+NS['r']+'}id')]
        if '..' in PurePosixPath(target).parts:raise ValueError('Nieprawidłowa ścieżka arkusza.')
        target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
        root=ET.fromstring(archive.read(target));rows=[]
        for row in root.findall('s:sheetData/s:row',NS):
            if len(rows)>MAX_ROWS:raise ValueError('Limit wynosi 25 000 rekordów.')
            cells={}
            for cell in row.findall('s:c',NS):
                letters=''.join(c for c in cell.get('r','') if c.isalpha());index=0
                for char in letters:index=index*26+ord(char.upper())-64
                if not 1<=index<=200:raise ValueError('Limit wynosi 200 kolumn.')
                if cell.find('s:f',NS) is not None:raise ValueError('Plik zawiera formuły. Zapisz dane jako wartości przed importem.')
                value=cell.findtext('s:v',default='',namespaces=NS)
                if cell.get('t')=='s':value=strings[int(value)] if value else ''
                elif cell.get('t')=='inlineStr':value=''.join(cell.find('s:is',NS).itertext())
                cells[index-1]=value
            if cells and any(str(value).strip() for value in cells.values()):rows.append([cells.get(i,'') for i in range(max(cells)+1)])
        return rows,[item.get('name') for item in sheets],sheet.get('name')

def read(input):
    data=base64.b64decode(input['content'],validate=True)
    if len(data)>15000000:raise ValueError('Plik przekracza limit 15 MB.')
    extension=input.get('filename','').rsplit('.',1)[-1].lower()
    if extension in ('json','geojson'):
        value=json.loads(data.decode('utf-8-sig'));rows=value if isinstance(value,list) else value.get('features') if isinstance(value,dict) and value.get('type')=='FeatureCollection' else None
        if not isinstance(rows,list):raise ValueError('JSON musi być tablicą lub GeoJSON FeatureCollection.')
        if not rows or len(rows)>MAX_ROWS:raise ValueError('Import musi zawierać od 1 do 25 000 rekordów.')
        if any(not isinstance(row,dict) for row in rows):raise ValueError('Każdy rekord musi być obiektem.')
        return {'rows':rows,'format':extension,'sheets':[]}
    if extension=='xlsx':table,sheets,selected=xlsx(data,input.get('sheet'))
    elif extension=='csv':
        try:text=data.decode('utf-8-sig')
        except UnicodeDecodeError:text=data.decode('cp1250')
        try:dialect=csv.Sniffer().sniff(text[:10000],delimiters=',;\t')
        except csv.Error:dialect=csv.excel
        table=list(csv.reader(io.StringIO(text),dialect));sheets=[];selected=None
    else:raise ValueError('Wybierz JSON, GeoJSON, CSV lub XLSX.')
    if not table or len(table)<2:raise ValueError('Plik musi zawierać nagłówki i co najmniej jeden rekord.')
    if len(table)>MAX_ROWS+1:raise ValueError('Limit wynosi 25 000 rekordów.')
    headers=[str(value).strip() for value in table[0]]
    if len(headers)>200 or any(not value or len(value)>200 for value in headers) or len(set(headers))!=len(headers):raise ValueError('Nagłówki muszą być niepuste i unikalne (do 200 kolumn).')
    rows=[]
    for index,row in enumerate(table[1:],2):
        if not any(str(value).strip() for value in row):continue
        if len(row)>len(headers):raise ValueError('Wiersz '+str(index)+' ma więcej kolumn niż nagłówków.')
        rows.append(dict(zip(headers,row+['']*(len(headers)-len(row)))))
    return {'rows':rows,'columns':headers,'format':extension,'sheets':sheets,'selectedSheet':selected}
try:
    output=read(json.load(sys.stdin));print(json.dumps(output,ensure_ascii=False))
except Exception as error:
    print(json.dumps({'error':str(error)},ensure_ascii=False));sys.exit(1)
