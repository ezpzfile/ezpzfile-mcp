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
whatever is missing.
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
    for name in ['sample.jtd', 'sample.xdw', 'sample.xbd', 'photo.heic']:
        if os.path.exists(os.path.join(extra, name)):
            shutil.copy(os.path.join(extra, name), os.path.join(out, name))

# ---------------------------------------------------------------- files that only say .hwp
open(f'{out}/fake-pdf.hwp', 'wb').write(open(f'{out}/doc.pdf', 'rb').read())
open(f'{out}/fake-web.hwp', 'wb').write(b'<!DOCTYPE html><html><body>Not found</body></html>')
open(f'{out}/empty.hwp', 'wb').write(b'')
print('samples in', out, sorted(os.listdir(out)))
