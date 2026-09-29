# EEZ Studio CLI / MCP: ปัญหาที่พบจากการทดลองใช้งาน

ทดสอบเมื่อ 2026-09-28 บน branch `feat/cli-integration` โดยใช้ EEZ Studio 0.30.0 ที่ติดตั้งแล้ว
(`%LOCALAPPDATA%\Programs\eezstudio`) และ source build ใน repo

งานที่ใช้ทดสอบ (ออกแบบจากภาพตัวอย่าง ทั้งสองงานผ่าน `check` 0 error และ `build` สำเร็จ):

| งาน | ช่องทาง | โปรเจกต์ |
|---|---|---|
| Weather forecast (LVGL 9.2.2, 360x480) | CLI + `apply` 70 คำสั่ง | `D:\WORK\MY_PROJECT\weather-ui` |
| Smart home dashboard (LVGL 9.2.2, 320x512) | MCP stdio, `eez_apply` 109 คำสั่ง, `eez_set`, `eez_style`, `eez_render` | `D:\WORK\MY_PROJECT\smart-home-ui` |

## สรุป

| # | ปัญหา | ความรุนแรง | สถานะ |
|---|---|---|---|
| 1 | `eez_set` / `eez_add_widget` ไม่ใช้ค่า `x`, `y`, `width` หรือ `height` ที่ส่งมาเพียงตัวเดียว | สูง | แก้แล้วใน repo |
| 2 | launcher หาโปรแกรมที่ติดตั้งแล้วผิด path | กลาง | แก้แล้วใน repo |
| 3 | `project new --size` ไม่ย้ายตำแหน่ง widget ของ template ตามขนาดจอใหม่ | กลาง | แก้แล้ว |
| 4 | ผลลัพธ์ MCP / JSON ยาวเกินจำเป็น เปลือง token ของ AI | กลาง | แก้แล้ว |
| 5 | รายงาน `overlaps` ปน widget ที่ตั้งใจวางซ้อน | กลาง | แก้แล้ว |
| 6 | แต่ละคำสั่ง CLI ใช้เวลาเริ่มต้นประมาณ 7-8 วินาที | กลาง | แก้แล้ว (หาสาเหตุเจอ + daemon) |
| 7 | `project new` / `eez_new_project` ตอบ `"saved": false` ทั้งที่สร้างไฟล์แล้ว | ต่ำ | แก้แล้ว |
| 8 | error ชื่อ property ผิดไม่เสนอชื่อที่ใกล้เคียง | ต่ำ | แก้แล้ว |
| 9 | เอกสารไม่ได้บอกว่าโปรแกรมที่ติดตั้งแล้วมี launcher มาให้ | ต่ำ | แก้แล้ว |
| 10 | ทำปุ่มแบบไอคอนต้องลบ Label ที่สร้างมาอัตโนมัติเอง | ต่ำ | แก้แล้ว |

ทุกข้อแก้ใน source แล้ว (`npm run test:cli` ผ่าน 16/16 test ซึ่งรวม test ใหม่ของข้อ 3, 5, 6, 7, 8 และ 10)
แต่ตัวที่ติดตั้งอยู่ยังเป็นโค้ดเดิม ต้อง build installer ใหม่ (`npm run build && npm run dist`) ผู้ใช้จึงจะได้รับการแก้ไข
รายละเอียดการแก้ของข้อ 3-10 อยู่ในหัวข้อ "สิ่งที่แก้ (ข้อ 3-10)" ท้ายเอกสาร

---

## 1. `eez_set` / `eez_add_widget` ไม่ใช้ค่า geometry ที่ส่งมาตัวเดียว (แก้แล้ว)

**อาการ:** `eez_set {"selector": "page:Main/wx_temp", "y": 58}` ล้มเหลวด้วย `nothing to set`
ส่วน `eez_add_widget` ที่ส่งแค่ `x` หรือแค่ `width` จะไม่ใช้ค่านั้นโดยไม่แจ้งอะไรเลย

**สาเหตุ:** `packages/cli/mcp/server.ts` ส่ง `--at` เฉพาะเมื่อมีทั้ง `x` และ `y`
และส่ง `--size` เฉพาะเมื่อมีทั้ง `width` และ `height` แต่การขยับ widget ทีละแกน
เป็นสิ่งที่ AI ทำบ่อยที่สุดตอนปรับ layout

**สิ่งที่แก้:**
- `packages/cli/commands/widget.ts`: `--at` และ `--size` รับค่าที่เว้นว่างไว้ครึ่งหนึ่งได้ เช่น `--at ,58` หรือ `--size 100,`
  ค่าที่เว้นไว้จะคงเดิม (มีเขียนไว้ใน `help widget set` แล้ว)
- `packages/cli/mcp/server.ts`: เพิ่ม `pushGeometry()` ซึ่งทั้ง `eez_set` และ `eez_add_widget` ใช้ร่วมกัน
- `packages/cli/test/cli.test.mjs`: เพิ่ม regression test ในส่วน MCP (`eez_set` ที่ส่งแค่ `y` แล้วตรวจว่า `left` ไม่เปลี่ยน)

ผลทดสอบ: `npm run test:cli` ผ่านทั้ง 12 test และ test ของ MCP ที่เพิ่ม regression case แล้วก็ผ่าน

## 2. launcher หาโปรแกรมที่ติดตั้งแล้วผิด path (แก้แล้ว)

installer วางโปรแกรมไว้ที่ `%LOCALAPPDATA%\Programs\eezstudio\` (ไม่มีขีด)
แต่ `installedExecutableCandidates()` ใน `packages/cli/launcher/eez-cli.js` หาที่ `Programs\eez-studio`
ตัวอย่างใน `docs/cli.md` ก็ใช้ path ผิดแบบเดียวกัน

ปัญหานี้เกิดเฉพาะเมื่อคัดลอก launcher ไปไว้ที่อื่น ตัวที่อยู่ใน `resources/cli/` ยังหาโปรแกรมเจอ
เพราะหาจากโฟลเดอร์ของตัวเอง

**สิ่งที่แก้:** เพิ่ม `Programs\eezstudio` เป็นตัวเลือกแรก (ยังเก็บ `eez-studio` ไว้) และแก้ตัวอย่างใน `docs/cli.md`

**ควรทำต่อ:** อ่านชื่อโฟลเดอร์จาก `installation/make-electron-builder-yml.ts` หรือจาก registry
(ค่า uninstall ของ NSIS) แทนการเขียน path ตายตัวไว้ในโค้ด

## 3. `project new --size` ไม่ย้ายตำแหน่ง widget ของ template

**อาการ:** `project new weather.eez-project --type lvgl --size 360x480` ได้ Label "Hello, world!" ที่ `@356,232`
ซึ่งเป็นกึ่งกลางของจอ 800x480 เดิม บนจอกว้าง 360 จึงตกขอบขวา
ผู้ใช้ที่ไม่ได้ลบ Label นี้จะเจอ `outside-screen` ตั้งแต่ render ครั้งแรก

**แนวทางแก้ (เลือกอย่างใดอย่างหนึ่ง):**
- เมื่อขนาดจอเปลี่ยน ให้คำนวณ `left` / `top` ของ widget ใน template ใหม่ตามสัดส่วน หรือจัดกึ่งกลางใหม่
- หรือเมื่อระบุ `--size` ให้ใช้หน้าเปล่า (ยังเก็บไฟล์ build ของ template ไว้)
  เพราะคนที่กำหนดขนาดจอเองส่วนใหญ่จะออกแบบหน้าใหม่อยู่แล้ว

## 4. ผลลัพธ์ MCP / JSON ยาวเกินจำเป็น

**อาการ:**
- ทุก tool ตอบกลับเป็น JSON envelope เต็มรูปแบบ (`ok`, `command`, `project`, `changes`, `saved` ...) แบบ pretty-print
- `schema class LVGLArcWidget` ส่ง property ของ base class ทั้งหมดกลับมาก่อน รวมถึงค่าที่เป็น computed หรือใช้ภายใน UI
  (`geometryProperties`, `styleUI`, `centerWidgetUI`, `timelineUI`, `alignAndDistribute` ...)
  ส่วน property เฉพาะของ Arc (`value`, `rangeMin`, `bgStartAngle`, `mode` ...) อยู่ท้ายสุด
  client ที่ตัดข้อความยาวจะไม่เห็นส่วนที่สำคัญที่สุด
- `eez_apply` 109 คำสั่งส่ง `changes` กลับมาครบทั้ง 109 บรรทัด

**ผลกระทบ:** เปลือง context ของ AI ทุกครั้งที่เรียก และข้อมูลสำคัญถูกดันไปอยู่ท้ายสุด

**แนวทางแก้:**
- `schema class`: ตัด property ที่เป็น `computed` ออกโดยปริยาย และแสดง property เฉพาะของ class ก่อน property ของ base widget
  (หรือเพิ่ม `--own` / `--all`)
- MCP: ใช้ JSON แบบ compact หรือตอบเป็นข้อความสั้น (รูปแบบเดียวกับ CLI ที่ไม่ใช้ `--json`) โดยปริยาย
- `eez_apply`: สรุปเป็นจำนวน เช่น `109 changes, saved` และแสดงรายละเอียดเฉพาะเมื่อมี error หรือ `newProblems`

## 5. รายงาน `overlaps` ปน widget ที่ตั้งใจวางซ้อน

**อาการ:** ในหน้า smart home ผล render รายงาน overlap 7 รายการ มีรายการเดียวที่เป็นปัญหาจริง
(icon กับ "24°C" ซ้อนกัน 4 px) อีก 6 รายการเป็น label หรือ icon ที่ตั้งใจวางไว้กลาง Arc
เมื่อทุกครั้งที่ render มีรายการที่ไม่ใช่ปัญหาปนอยู่ AI จะเริ่มมองข้ามคำเตือนนี้

**แนวทางแก้:**
- แยก "contains" (widget หนึ่งอยู่ในอีก widget ทั้งหมด ซึ่งมักตั้งใจ) ออกจาก "partial overlap" (ซ้อนกันบางส่วน ซึ่งมักเป็นปัญหา)
  และรายงานเป็น issue เฉพาะแบบหลังโดยปริยาย
- หรือให้ระบุว่า widget ใดอนุญาตให้ซ้อนได้ (เช่น `render page --allow-overlap temp_arc,hum_arc`)

## 6. แต่ละคำสั่ง CLI ใช้เวลาเริ่มต้นประมาณ 7-8 วินาที

**อาการ:** ทุกคำสั่ง ทั้ง `help`, `info` และ `lvgl-style props` ใช้เวลาประมาณ 8 วินาที เพราะต้องเปิด Electron
และโหลด project model ใหม่ทุกครั้ง แต่ตัวคำสั่งเองใช้แค่ 1-200 ms
(วัดผ่าน MCP: `eez_apply` 109 คำสั่งใช้ 90 ms, `eez_render` ใช้ 180 ms และ `initialize` ใช้ 6.9 วินาที)

**ผลกระทบ:** AI ที่เรียก CLI ทีละคำสั่งเพื่อค้นหาข้อมูล (`schema`, `props`, `parts`) ต้องรอนานมาก

**แนวทางแก้:**
- เพิ่ม daemon ที่ launcher เชื่อมต่อได้ถ้ามีตัวที่รันค้างอยู่แล้ว (เช่น `eez-cli serve` ผ่าน named pipe หรือ localhost)
  แล้วให้ `eez-cli <command>` ส่งคำสั่งไปที่ตัวนั้นแทนการเปิดโปรแกรมใหม่
- อย่างน้อยให้ `help` และ `schema` ที่ไม่ต้องใช้ project ทำงานได้โดยไม่ต้องสร้าง hidden window
- เขียนใน SKILL.md ให้ชัดว่าควรใช้ `apply`, `repl` หรือ MCP แทนการเรียกทีละคำสั่ง

## 7. `project new` ตอบ `"saved": false` ทั้งที่สร้างไฟล์แล้ว

`eez_new_project` ตอบกลับ `"changes": [..., "created ...smarthome.eez-project"]` แต่ `"saved": false`
และไฟล์ก็ถูกเขียนลงดิสก์แล้ว client ที่ตรวจค่า `saved` จะเข้าใจผิดว่าบันทึกไม่สำเร็จ
ควรตอบ `"saved": true` หรือเพิ่ม field `"created": true`

## 8. error ชื่อ property ผิดไม่เสนอชื่อที่ใกล้เคียง

`shadow_offset_y=4` ได้ error `Unknown LVGL style property "shadow_offset_y"` พร้อม hint ให้รัน `lvgl-style props`
ต้องรันคำสั่งเพิ่มอีกรอบ (ประมาณ 8 วินาที) เพื่อหาชื่อที่ถูก ซึ่งคือ `shadow_ofs_y`
ควรใช้ fuzzy match (Levenshtein หรือเทียบทีละ token เช่น `offset` เป็น `ofs`) แล้วเสนอ `did you mean "shadow_ofs_y"?`
และทำแบบเดียวกันกับชื่อ widget type, enum value, selector และชื่อ style/color/font ที่หาไม่เจอ

## 9. เอกสารไม่ได้บอกว่าโปรแกรมที่ติดตั้งแล้วมี launcher มาให้

`docs/cli.md` บอกให้ใช้ launcher จาก checkout หรือคัดลอก `eez-cli.js` ไปใช้เอง
แต่ตัวติดตั้งมี `resources/cli/eez-cli.js` มาให้แล้ว และใช้งานได้ทันที:

```bash
node "%LOCALAPPDATA%/Programs/eezstudio/resources/cli/eez-cli.js" help
claude mcp add eez-studio -- node "C:/Users/<user>/AppData/Local/Programs/eezstudio/resources/cli/eez-cli.js" mcp
```

ควรเพิ่มตัวอย่างนี้ (รวมถึง path บน macOS และ Linux) ใน `docs/cli.md` ส่วน "Running" และส่วน "MCP server"
และใน `packages/cli/skill/SKILL.md`

## 10. ทำปุ่มแบบไอคอนต้องลบ Label ที่สร้างมาอัตโนมัติเอง

`widget add Button` สร้าง Label ลูกมาให้ ถ้าจะทำปุ่มที่มีแต่ไอคอน ต้อง `widget rm page:Main/nav_home/[0]` เอง
แล้วค่อยเพิ่ม Image ใช้งานได้ (และมีเขียนไว้ใน SKILL.md) แต่ถ้ามี `--no-label` หรือ `--icon <image>`
จะลดจำนวนคำสั่งและโอกาสที่ selector จะผิด

---

## สิ่งที่แก้ (ข้อ 3-10)

### 3. `project new --size`
`packages/cli/commands/project.ts` (`repositionTemplateWidgets`): เมื่อระบุ `--size`
widget ของ template จะถูกย้ายโดยรักษาจุดกึ่งกลางไว้ที่ตำแหน่งสัดส่วนเดิมของจอ
เช่น "Hello, world!" จาก `@356,232` (800x480) เป็น `@136,232` (360x480) test: `project new --size keeps template widgets on the screen`

### 4. ผลลัพธ์ยาวเกินจำเป็น
- MCP (`packages/cli/mcp/server.ts`): คำสั่งที่อ่านอย่างเดียว (help, schema, tree, list ...) ตอบเป็นข้อความสั้นแบบ CLI
  คำสั่งที่แก้ไขตอบ JSON แบบ compact ไม่มี field ว่าง, `changes` เกิน 8 รายการจะสรุปเป็น `... and N more`
  และ `newProblems` เหลือแค่ `type`, `text`, `at`
- `apply`: ตอบ `{operations, created: [selector...]}` ผลของแต่ละคำสั่งแสดงเมื่อใส่ `--verbose`
- `schema class` / `obj props`: ซ่อน property ที่เป็น computed (`geometryProperties`, `styleUI`, `timelineUI` ...)
  แสดง property ของ class เองก่อน แล้วค่อยเป็น "inherited from ..." (`--all` แสดงครบ)

### 5. `overlaps`
`packages/cli/commands/render.ts`: widget ที่อยู่ภายในพี่น้องทั้งหมด ไม่นับเป็น issue แล้ว
(`--layout` แสดงเป็น `(on page:Main/arc)` และ JSON มี `stackedOn`) รายงานเฉพาะการซ้อนกันบางส่วน
เพิ่ม `--allow-overlap a,b` สำหรับกรณีที่ตั้งใจซ้อนบางส่วน

### 6. เวลาเริ่มต้น 7-8 วินาที
**สาเหตุจริง:** เมื่อมี EEZ Studio GUI เปิดอยู่ Chromium ของ process CLI ต้องรอ lock ของ localStorage ของ profile เดียวกัน
ประมาณ 5.5 วินาที (`home-layout-models.ts` อ่าน `window.localStorage` ตอน import) ตอนไม่มี GUI เปิดใช้เพียงประมาณ 1.4 วินาที
- `packages/main/cli-main.ts` (`useTemporarySessionData`): process CLI ใช้ session folder ชั่วคราวของตัวเอง
  (launcher สร้างและลบให้) ส่วน settings และฐานข้อมูลของแอพยังใช้ที่เดิม ผลคือประมาณ 1.3 วินาทีต่อคำสั่ง แม้ GUI เปิดอยู่
- daemon: `eez-cli daemon start [--idle 30]` / `status` / `stop` คำสั่งต่อจากนั้นส่งผ่าน localhost socket
  (มี token ใน `<tmp>/eez-cli-daemon.json`) ใช้ประมาณ 70-150 ms ต่อคำสั่ง
  `EEZ_CLI_DAEMON=auto` เริ่ม daemon ให้อัตโนมัติ `EEZ_CLI_DAEMON=off` ข้าม daemon
  คำสั่ง `repl`, `mcp` และคำสั่งที่อ่าน stdin ยังรันแยก process เหมือนเดิม
- ผลต่อ test: ชุด test ทั้งหมดจาก 5 นาทีเหลือ 51 วินาที (ขณะที่ GUI เปิดอยู่)

### 7. `saved`
`project new` ตอบ `"saved": true` แล้ว (`ctx.saved` ใน `packages/cli/context.ts`)
และคำสั่งที่ล้มเหลวจะไม่แสดง/ส่ง `changes` บางส่วนที่ไม่ได้บันทึกอีกต่อไป

### 8. ชื่อผิด
`packages/cli/suggest.ts`: fuzzy match (Levenshtein + แปลงคำ เช่น offset → ofs, opacity → opa, background → bg)
ใช้กับ style property, property ของ widget, ชนิด widget / class, enum value, selector (หน้า, widget, style, font, color ...),
reference (font, bitmap, style ...), variable, action, theme เช่น
`shadow_offset_y` → `did you mean "shadow_ofs_y"?`, `Buton` → `"Button"`, `mode=RANGEE` → `"RANGE"`

### 9. เอกสาร
`docs/cli.md` และ `packages/cli/skill/SKILL.md`: path ของ launcher ในโปรแกรมที่ติดตั้ง (Windows/macOS/Linux),
คำสั่ง `claude mcp add` สำหรับโปรแกรมที่ติดตั้ง, daemon, รูปแบบผลลัพธ์ของ MCP

### 10. ปุ่มไอคอน
`widget add Button --icon <bitmap>` (ลบ Label แล้วเพิ่ม Image ที่ `align=CENTER`) และ `--no-label`
มีใน MCP `eez_add_widget` ด้วย (`icon`, `noLabel`)

### ปัญหาที่เจอเพิ่มระหว่างแก้
- คำสั่งที่เรียกคำสั่งอื่น (`apply`, `--icon`) รับ option ทั้งหมดของคำสั่งแม่ไปด้วย ทำให้ `--icon` วนซ้ำจน stack overflow
  แก้ให้คำสั่งลูกรับเฉพาะ option กลาง (`-p`, `--force`, `--strict`, `--dry-run`, `--no-backup`, `--no-reload-gui`)
- ข้อ 2 "ควรทำต่อ" (อ่าน path ติดตั้งจาก registry) ยังไม่ได้ทำ

---

## สิ่งที่ทำงานดี (ไม่ต้องแก้)

- `apply` / `eez_apply` เป็น transaction จริง คำสั่งที่ 15 ล้มก็ไม่มีอะไรถูกบันทึก แก้แล้วรันใหม่ได้ทันที
- ภาพที่ render ตรงกับ LVGL runtime ทั้ง gradient, shadow, `clip_corner`, Arc (MAIN/INDICATOR/KNOB), รูป PNG ที่มี alpha และตัวอักษร `°`
- MCP ทำงานตามโปรโตคอล (initialize, tools/list, tools/call) และ `eez_render` ส่งภาพกลับเป็น image content
- ใช้ named color และ shared style ได้ `check` ตรวจ reference ครบ ส่วน `build` สร้างโค้ด C สำเร็จ
- selector อ่านง่าย (`page:Main/hum_val`, `Main/nav_home/[0]`) และคำสั่งส่ง selector ของ widget ที่สร้างกลับมาให้ใช้ต่อ

## ยังไม่ได้ทดสอบ

- การลงทะเบียน MCP ใน Claude Code (`claude mcp add`) แล้วเรียกเป็น tool จริง
  (ครั้งนี้ใช้ stdio client ที่เขียนขึ้นเอง ซึ่งใช้โปรโตคอลเดียวกัน)
- การสั่ง GUI reload ตอนที่ EEZ Studio เปิดโปรเจกต์ค้างไว้ รวมถึงกรณีที่มี edit ใน GUI ที่ยังไม่ได้บันทึก
- โปรเจกต์ที่มี flow (`lvgl-flow`) เช่น variable, action, event handler และ `flow connect`
- การ render EEZ-GUI (firmware) และ Dashboard รวมถึง `--theme` และ `--dark`
- ฟอนต์ภาษาไทย (`font add --ranges 0x0E00-0x0E7F`)
- macOS และ Linux
