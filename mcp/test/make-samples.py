"""
Sample files for test/protocol.mjs.

    python3 test/make-samples.py /tmp/samples
    node test/protocol.mjs /tmp/samples

Everything here is made up on the spot, so nothing private ends up in a test run.
Needs Pillow, python-docx, openpyxl and reportlab (pip install pillow python-docx
openpyxl reportlab).

Ichitaro, DocuWorks and HEIC files cannot be made without the programs that
write them. Put real ones in a folder named by EZPZ_EXTRA_SAMPLES as sample.jtd,
sample.xdw, sample.xbd and photo.heic and they are copied in; the test skips
whatever is missing. sample.psd there is used by test/scenarios.mjs as well.
"""
import os, sys, shutil
from email.message import EmailMessage
from email.headerregistry import Address

out = sys.argv[1] if len(sys.argv) > 1 else '/tmp/samples'
os.makedirs(out, exist_ok=True)
FONTS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'public', 'vendor', 'fonts')

# ---------------------------------------------------------------- images
from PIL import Image, ImageDraw

def photo(w, h):
    im = Image.new('RGB', (w, h))
    px = im.load()
    for y in range(h):
        for x in range(w):
            px[x, y] = (int(255 * x / w), int(180 * y / h) + 40, 160)
    d = ImageDraw.Draw(im)
    d.ellipse((w * 0.3, h * 0.25, w * 0.7, h * 0.75), fill=(250, 220, 90))
    return im

p = photo(1200, 800)
p.save(f'{out}/photo.jpg', quality=92)
p.save(f'{out}/photo.webp', quality=90)

logo = Image.new('RGBA', (400, 200), (0, 0, 0, 0))
d = ImageDraw.Draw(logo)
d.rounded_rectangle((10, 10, 390, 190), 40, fill=(40, 90, 200, 255))
d.ellipse((150, 50, 250, 150), fill=(255, 255, 255, 255))
logo.save(f'{out}/logo.png')

# JPEG with camera fields and a GPS position (Seoul City Hall)
exif = Image.Exif()
exif[0x010F] = 'Apple'
exif[0x0110] = 'iPhone 15 Pro'
exif[0x0131] = '17.0'
exif[0x0132] = '2026:09:20 14:03:22'
gps = {1: 'N', 2: (37.0, 33.0, 59.4), 3: 'E', 4: (126.0, 58.0, 41.0), 5: 0, 6: 38.0}
exif[0x8825] = gps
p.save(f'{out}/photo_exif.jpg', quality=90, exif=exif)

# ---------------------------------------------------------------- docx
from docx import Document
doc = Document()
doc.add_heading('2026 Quarterly Report', 0)
doc.add_heading('Summary', level=1)
doc.add_paragraph('Revenue grew 12% this quarter. 이번 분기 매출은 12% 늘었습니다.')
for item in ['North region up 8%', 'South region up 15%', '해외 매출 첫 흑자']:
    doc.add_paragraph(item, style='List Bullet')
doc.add_heading('Figures', level=1)
t = doc.add_table(rows=3, cols=3)
t.style = 'Table Grid'
for r, row in enumerate([['Region', 'Q2', 'Q3'], ['North', '120', '130'], ['South', '80', '92']]):
    for c, v in enumerate(row):
        t.cell(r, c).text = v
doc.core_properties.author = 'Mina Park'
doc.core_properties.title = 'Quarterly Report'
doc.core_properties.last_modified_by = 'Jun Lee'
doc.save(f'{out}/report.docx')

# ---------------------------------------------------------------- xlsx, csv
from openpyxl import Workbook
wb = Workbook()
ws = wb.active
ws.title = 'Sales'
for row in [['Month', 'Units', 'Revenue'], ['Jan', 10, 1000], ['Feb', 12, 1200], ['Mar', 9, 900]]:
    ws.append(row)
memo = wb.create_sheet('메모')
memo.append(['날짜', '내용'])
memo.append(['2026-09-01', '첫 출고'])
wb.save(f'{out}/table.xlsx')
with open(f'{out}/table_euckr.csv', 'wb') as f:
    f.write('이름,부서,연락처\n김민수,영업,010-1234-5678\n이영희,개발,010-9876-5432\n'.encode('euc-kr'))

# ---------------------------------------------------------------- eml
msg = EmailMessage()
msg['Subject'] = '견적서 보내드립니다 (Quote attached)'
msg['From'] = Address('김민수', 'minsu', 'example.com')
msg['To'] = 'buyer@example.org'
msg['Date'] = 'Mon, 21 Sep 2026 10:00:00 +0900'
msg.set_content('안녕하세요,\n요청하신 견적서를 첨부합니다.\n\nThanks,\nMinsu')
msg.add_attachment(b'%PDF-1.4 fake', maintype='application', subtype='pdf', filename='quote.pdf')
with open(f'{out}/mail.eml', 'wb') as f:
    f.write(bytes(msg))

# ---------------------------------------------------------------- pdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
pdfmetrics.registerFont(TTFont('Nanum', f'{FONTS}/NanumGothic-Regular.ttf'))
W, H = A4
c = canvas.Canvas(f'{out}/doc.pdf', pagesize=A4)
c.setTitle('Sample document')
c.setAuthor('EZPZ test')

# 1: heading and paragraphs
c.setFont('Helvetica-Bold', 22)
c.drawString(72, H - 90, 'Invoice 2026 for ACME Corp')
c.setFont('Helvetica', 11)
y = H - 130
for line in [
    'This invoice covers the services ACME Corp ordered in September.',
    'Payment is due within 30 days. ACME Corp has been a client since 2019.',
    'Questions go to billing@example.com.',
]:
    c.drawString(72, y, line)
    y -= 16
c.setFont('Nanum', 11)
y -= 10
for line in ['이 문서는 시험용 견적서입니다.', '금액은 부가세를 포함합니다.']:
    c.drawString(72, y, line)
    y -= 16
# the same phrase drawn as two pieces: a PDF that splits it
c.setFont('Helvetica', 11)
c.drawString(72, y - 10, 'Signed for ACME')
c.setFont('Helvetica-Bold', 11)
c.drawString(72 + pdfmetrics.stringWidth('Signed for ACME', 'Helvetica', 11), y - 10, ' Corp')
c.showPage()

# 2: a table
c.setFont('Helvetica-Bold', 16)
c.drawString(72, H - 90, 'Line items')
rows = [['Item', 'Qty', 'Price', 'Total'], ['Design', '2', '500', '1000'], ['Hosting', '12', '20', '240'], ['Support', '5', '80', '400'], ['Training', '1', '300', '300']]
cols = [72, 250, 330, 420, 520]
top = H - 120
c.setFont('Helvetica', 11)
for r, row in enumerate(rows):
    yy = top - r * 24
    for i, v in enumerate(row):
        c.drawString(cols[i] + 6, yy - 16, v)
    c.line(cols[0], yy, cols[-1], yy)
c.line(cols[0], top - len(rows) * 24, cols[-1], top - len(rows) * 24)
for x in cols:
    c.line(x, top, x, top - len(rows) * 24)
c.showPage()

# 3: picture and text
c.setFont('Helvetica-Bold', 16)
c.drawString(72, H - 90, 'Our logo')
c.drawImage(f'{out}/logo.png', 72, H - 330, width=200, height=100, mask='auto')
c.setFont('Helvetica', 11)
c.drawString(72, H - 360, 'The logo above is part of the brand guide.')
c.showPage()

# 4: more text
c.setFont('Helvetica', 11)
c.drawString(72, H - 90, 'Page four: closing notes. Thank you, ACME Corp.')
c.showPage()

# 5: a "scan": picture only, no text
c.drawImage(f'{out}/photo.jpg', 0, 0, width=W, height=H)
c.showPage()
c.save()

# ---------------------------------------------------------------- Japanese documents, HEIC
extra = os.environ.get('EZPZ_EXTRA_SAMPLES')
if extra:
    for name in ['sample.psd', 'sample.jtd', 'sample.xdw', 'sample.xbd', 'photo.heic']:
        if os.path.exists(os.path.join(extra, name)):
            shutil.copy(os.path.join(extra, name), os.path.join(out, name))

# ---------------------------------------------------------------- files that only say .hwp
open(f'{out}/fake-pdf.hwp', 'wb').write(open(f'{out}/doc.pdf', 'rb').read())
open(f'{out}/fake-web.hwp', 'wb').write(b'<!DOCTYPE html><html><body>Not found</body></html>')
open(f'{out}/empty.hwp', 'wb').write(b'')
print('samples in', out, sorted(os.listdir(out)))

# ---------------------------------------------------------------- for test/scenarios.mjs
# A quote template: placeholders (one of them split over two runs, as Word does),
# a repeating row and a merged cell.
tpl = Document()
tpl.add_heading('견적서 Quote', 1)
p = tpl.add_paragraph('고객: ')
p.add_run('{{cus')
p.add_run('tomer}}').bold = True
tpl.add_paragraph('날짜 {{ date }}')
t = tpl.add_table(rows=3, cols=3)
t.style = 'Table Grid'
for i, h in enumerate(['품목', '수량', '단가']):
    t.cell(0, i).text = h
for i, h in enumerate(['{{items.name}}', '{{items.qty}}', '{{items.price}}']):
    t.cell(1, i).text = h
merged = t.cell(2, 0).merge(t.cell(2, 1))
merged.text = '합계'
t.cell(2, 2).text = '{{total}}'
tpl.add_paragraph('담당 {{owner}}')
tpl.save(f'{out}/quote-template.docx')

# A letter with personal details to redact.
c = canvas.Canvas(f'{out}/people.pdf', pagesize=A4)
c.setFont('Nanum', 12)
for k, line in enumerate([
    '민원 처리 결과 안내',
    '신청인: 김하늘 (010-1234-5678)',
    '주소: 서울시 중구 세종대로 110',
    '처리 결과: 승인',
    '담당자 연락처 02-120',
]):
    c.drawString(72, 780 - 24 * k, line)
c.showPage()
c.setFont('Nanum', 12)
c.drawString(72, 780, '첨부: 김하늘 님 신분 확인 기록')
c.save()

# A small DXF (R12): two layers, a frame, a line and two texts.
def dxf(entities):
    head = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
            '0', 'LAYER', '2', 'WALLS', '70', '0', '62', '1', '6', 'CONTINUOUS',
            '0', 'LAYER', '2', 'NOTES', '70', '0', '62', '5', '6', 'CONTINUOUS',
            '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES']
    return '\n'.join(head + entities + ['0', 'ENDSEC', '0', 'EOF']) + '\n'
ents = []
for (x0, y0, x1, y1) in [(0, 0, 420, 0), (420, 0, 420, 297), (420, 297, 0, 297), (0, 297, 0, 0), (50, 50, 300, 200)]:
    ents += ['0', 'LINE', '8', 'WALLS', '10', str(x0), '20', str(y0), '30', '0', '11', str(x1), '21', str(y1), '31', '0']
for (x, y, t) in [(60, 260, 'FLOOR PLAN 1F'), (60, 240, 'SCALE 1:100')]:
    ents += ['0', 'TEXT', '8', 'NOTES', '10', str(x), '20', str(y), '30', '0', '40', '8', '1', t]
open(f'{out}/plan.dxf', 'w').write(dxf(ents))

# The quote as a PDF too, made by LibreOffice when it is installed (its fonts are subsets
# with their own numbering, the case that broke text rewriting once).
import shutil as _sh, subprocess as _sp
if _sh.which('soffice'):
    _sp.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', out, f'{out}/quote-template.docx'], stdout=_sp.DEVNULL, stderr=_sp.DEVNULL, timeout=120)

# A business-card SVG and a list of people for batch templates.
open(f'{out}/card.svg', 'w').write('<svg xmlns="http://www.w3.org/2000/svg" width="90mm" height="50mm" viewBox="0 0 255 142"><rect width="255" height="14" fill="#0155FF"/><text x="18" y="48" font-size="14">홍길동</text><text x="18" y="62" font-size="8">디자이너</text><text x="18" y="112" font-size="8">010-0000-0000</text></svg>')
with open(f'{out}/people.csv', 'w', encoding='utf-8') as f:
    f.write('name,title,phone\n김하늘,디자이너,010-1000-5000\n이민준,개발자,010-1001-5001\n박서연,대표,010-1002-5002\n')
