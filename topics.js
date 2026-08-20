/* ============================================================
   topics.js — SINGLE SOURCE OF TRUTH for the ThaiEar topic list.
   ------------------------------------------------------------
   ONE list, consumed by:
     • index.html  — renders the topic grid (cards, levels, lock, search).
     • every topic page — derives its eyebrow (the difficulty) from this list.
     • (progress.html / sentences.html were consumers until 2026-08-20; both retired — see PLAYS_COUNTER.md)
     • player.js — continuous-playback sequence + prev/next.
   Add / remove / reorder HERE ONLY — no per-page edits, exactly like nav.js
   owns the top bar.

   ── THE UNIT MODEL (changed 2026-07-17 — read this) ──
   The array is a flat list of UNITS. A unit = ONE playable page. A split
   topic's parts are SEPARATE units, each with its own `part` index, its own
   `levels`, and its own `access`. They are NO LONGER nested under a `parts`
   array, and they NO LONGER have to sit next to each other in the grid.

   Why: difficulty is a property of the SENTENCE, so a "part 2" often ramps a
   whole band above its part 1 (e.g. Getting around & transport 2 averages
   42.0 Thai chars vs part 1's 27.6 — a bigger gap than most topic pairs).
   Nesting forced them to share a level and a slot, which mis-sold both.

   INVARIANTS (enforced by the 2026-07-17 re-order; keep them true):
     • Array order = DISPLAY order.
     • `id` is the FROZEN internal handle (spreadsheet #, topic-{id}.html,
       audio handle). NEVER renumber it. Reordering the array is free precisely
       BECAUSE ids/filenames/audio prefixes are position-independent.
     • A part NEVER precedes a lower-numbered part of the same id. Parts may be
       far apart, but part 1 always comes first. (Body & health and Romantic
       relationships were both kept contiguous for narrative reasons — their
       vocabulary/arc depends on the earlier part.)
     • The first three units are the free tier. Don't displace them.

   ── LEVEL DISPLAY — difficulty is a RANGE, not a single badge ──
   A unit's label shows a RANGE from its lowest level present (floor) to its
   highest (ceiling).
     Level order: beg < li1 < li2 < adv   (adv = Advanced: tertiary / niche)
     - floor == ceiling -> single label   e.g. "Beginner"
     - floor != ceiling -> range          e.g. "Beginner -> Lower intermediate"
   NEVER collapse a two-level unit to "Mixed levels" — "Mixed" is the label that
   erased the intermediate tier. The eyebrow on each topic page uses this SAME
   text, so page and index card always agree.

   ── ACCESS ──
   access: "member" (any signed-in user) or "premium" (active subscription);
   omitting it (or "free") = open. THIS ARRAY IS THE SINGLE SOURCE OF TRUTH for
   the free/member/premium split — it drives the index cards AND the prev/next
   buttons. You do NOT hand-lock prev/next: decorateTopicNav() reads each
   button's destination unit and locks/unlocks to match. Backend enforcement of
   the audio is server-side (functions/api/audio.js); this layer is UX only.

   ── SEARCH ──
   Each unit carries an authored `keywords` array (synonyms + key Thai terms).
   searchUnits() requires EVERY typed token to match (AND, never OR) — that is
   what stops a two-word query returning half the site. See searchUnits() below.
   ============================================================ */

(function () {
  'use strict';

  // A unit = one page. `part` present only for split topics. `keywords` = authored
  // search synonyms (DRAFT 2026-07-17 — pending an owner review pass).
  const topics = [
    // ── BEGINNER ────────────────────────────────────
    { id: 1, name: "Greetings & farewells", levels: ['beg'], sentences: 23, page: "topic-01.html", audio: "Greetings_BEG",
      keywords: ['hello','hi','goodbye','greeting','sawasdee','สวัสดี','polite','thanks','ขอบคุณ','sorry','bye','wai','introduction'] },
    { id: 2, name: "Getting to know you", levels: ['beg'], sentences: 29, page: "topic-02.html", audio: "GettingToKnow_BEG",
      keywords: ['introduce','name','nationality','age','where from','meeting people','small talk','ชื่อ','อายุ','getting acquainted'] },
    { id: 3, name: "Communication survival", levels: ['beg'], sentences: 25, page: "topic-03.html", audio: "CommSurvival_BEG",
      keywords: ['survival','understand','repeat','slowly','dont understand','ไม่เข้าใจ','help me','speak','พูด','translate','confused','again'] },
    { id: 11, part: 1, name: "Shopping & money 1", levels: ['beg'], sentences: 22, page: "topic-11a.html", audio: "ShoppingAndMoney_BEG",
      keywords: ['shopping','money','price','buy','cost','เท่าไหร่','how much','บาท','baht','cheap','expensive','pay','แพง'] },   // re-badged by the 2026-07-17 length audit
    { id: 4, part: 1, name: "Colours & descriptions 1", levels: ['beg'], sentences: 21, page: "topic-04a.html", audio: "ColoursAndDescriptions_BEG",
      keywords: ['colour','color','red','blue','green','สี','describe','description','adjective','big','small','แดง'] },
    { id: 4, part: 2, name: "Colours & descriptions 2", levels: ['beg'], sentences: 22, page: "topic-04b.html", audio: "ColoursAndDescriptions2_BEG", access: "premium",
      keywords: ['colour','color','shade','describe','description','adjective','pattern','dark','light','สี','bright'] },
    { id: 40, name: "Animals", levels: ['beg'], sentences: 37, page: "topic-40.html", audio: "Animals_BEG", access: "premium",
      keywords: ['animal','สัตว์','dog','หมา','cat','แมว','pet','elephant','ช้าง','bird','นก','fish','zoo','wildlife','buffalo','ควาย'] },
    { id: 6, name: "Time & numbers", levels: ['beg'], sentences: 30, page: "topic-06.html", audio: "Time_BEG", access: "premium",
      keywords: ['time','number','clock','hour','นาฬิกา','เวลา','count','counting','นับ','oclock','minute','how many','เลข'] },
    { id: 9, part: 1, name: "Food & drink 1", levels: ['beg'], sentences: 42, page: "topic-09a.html", audio: "Food_BEG",
      keywords: ['food','eat','drink','กิน','อาหาร','rice','ข้าว','water','น้ำ','hungry','หิว','delicious','อร่อย','meal','restaurant'] },   // re-badged by the 2026-07-17 length audit
    { id: 41, part: 1, name: "Places around town 1", levels: ['beg'], sentences: 28, page: "topic-41a.html", audio: "Places_BEG", access: "premium",
      keywords: ['place','town','city','เมือง','where','bank','post office','market','ตลาด','shop','ร้าน','location','directions','around town'] },
    { id: 46, name: "Groceries", levels: ['beg'], sentences: 38, page: "topic-46.html", audio: "Groceries_BEG", access: "premium",
      keywords: ['grocery','groceries','supermarket','market','ตลาด','shopping list','vegetable','ผัก','fruit','ผลไม้','meat','เนื้อ','egg','ไข่','milk'] },
    { id: 8, name: "Family & relationships", levels: ['beg'], sentences: 38, page: "topic-08.html", audio: "Family_BEG", access: "premium",
      keywords: ['family','ครอบครัว','mother','แม่','father','พ่อ','brother','sister','พี่','น้อง','relative','parents','children','ลูก','relationship'] },
    { id: 41, part: 2, name: "Places around town 2", levels: ['beg'], sentences: 29, page: "topic-41b.html", audio: "Places2_BEG", access: "premium",
      keywords: ['place','town','city','เมือง','building','directions','ทาง','landmark','hospital','โรงพยาบาล','school','โรงเรียน','temple','วัด','around town'] },
    { id: 5, name: "Weather & seasons", levels: ['beg'], sentences: 32, page: "topic-05.html", audio: "Weather_BEG", access: "premium",
      keywords: ['weather','อากาศ','rain','ฝน','hot','ร้อน','cold','หนาว','season','ฤดู','sun','แดด','storm','cool','humid','climate'] },
    { id: 7, name: "Days & months", levels: ['beg'], sentences: 37, page: "topic-07.html", audio: "Dates_BEG", access: "premium",
      keywords: ['day','month','วัน','เดือน','date','calendar','week','อาทิตย์','year','ปี','today','วันนี้','tomorrow','พรุ่งนี้','yesterday','birthday'] },

    // The two SPECIALS close the Beginner band. Length is the wrong instrument for both — an idiom
    // and a tone twister are short strings that are hard for reasons character count can't see — so
    // they are NOT length-sorted like everything else. They sit at the END of the beginner run: early
    // enough to be the fun, inviting thing they are, but never fronting the corpus as if they were the
    // easiest pages on the site. Owner decision 2026-07-17. Keep them here and keep them adjacent;
    // Idioms first (they were one topic, ID 38, before the 38/39 split).
    // BOTH were also re-badged to ['beg'] (from beg/li1 and li1/li2) so they group into this band —
    // that makes 10 re-badges in total, not the 8 you get by counting the inline markers below.
    // ⚠ Tongue twisters' AUDIO stays `ToneTwister_LI1` and its JSON stays `level: LI1`. That is CORRECT
    // and must not be "fixed" to match this badge: the level in an audio handle is a frozen filename
    // component, not a difficulty claim. Renaming it 404s every R2 URL. Same for Idioms (`Idiom_BEG`).
    // ⚠⚠ RENAMED FOR DISPLAY 2026-08-13: "Tone twisters" -> "Tongue twisters" (owner). DISPLAY ONLY.
    // The audio handle `ToneTwister_LI1`, the page filename `topic-39.html` and the id 39 are ALL
    // unchanged and must stay that way — the handle is what every R2 URL and every offline download
    // is keyed off. `tone twister` is deliberately KEPT in the keywords so search still finds it.
    { id: 38, name: "Idioms", levels: ['beg'], sentences: 27, page: "topic-38.html", audio: "Idiom_BEG", access: "premium",
      keywords: ['idiom','สำนวน','saying','expression','proverb','figure of speech','phrase','metaphor','สุภาษิต','colloquial'] },
    { id: 39, name: "Tongue twisters", levels: ['beg'], sentences: 19, page: "topic-39.html", audio: "ToneTwister_LI1", access: "premium",
      keywords: ['tone','tone twister','tongue twister','pronunciation','drill','practice','เสียง','vowel','minimal pair','ear training','accent'] },

    // ── BEGINNER → LOWER INTERMEDIATE ───────────────
    { id: 9, part: 2, name: "Food & drink 2", levels: ['beg','li1'], sentences: 27, page: "topic-09b.html", audio: "Food_LI1", access: "premium",
      keywords: ['food','drink','อาหาร','order','ordering','menu','เมนู','taste','รสชาติ','spicy','เผ็ด','sweet','หวาน','snack','fruit'] },
    { id: 19, part: 1, name: "Cooking & recipes 1", levels: ['beg','li1'], sentences: 34, page: "topic-19a.html", audio: "Cooking_BEG", access: "premium",
      keywords: ['cook','cooking','ทำอาหาร','kitchen','ครัว','fry','ผัด','boil','ต้ม','ingredient','pan','pot','chop','recipe','stove'] },
    { id: 12, part: 1, name: "Getting around & transport 1", levels: ['beg','li1'], sentences: 27, page: "topic-12a.html", audio: "Transport_BEG", access: "premium",
      keywords: ['transport','travel','getting around','bus','รถเมล์','taxi','แท็กซี่','train','รถไฟ','motorbike','มอเตอร์ไซค์','tuk tuk','ride','fare','bts','mrt'] },
    { id: 37, part: 1, name: "Asking for help & emergencies 1", levels: ['beg','li1'], sentences: 21, page: "topic-37.html", audio: "Emergency_BEG", access: "premium",
      keywords: ['help','emergency','ช่วย','ฉุกเฉิน','police','ตำรวจ','ambulance','accident','อุบัติเหตุ','fire','ไฟไหม้','danger','hospital','lost','urgent','สายด่วน'] },
    { id: 37, part: 2, name: "Asking for help & emergencies 2", levels: ['beg','li1'], sentences: 19, page: "topic-37b.html", audio: "Emergency2_BEG", access: "premium",
      keywords: ['help','emergency','ช่วย','ฉุกเฉิน','police','ตำรวจ','ambulance','accident','อุบัติเหตุ','fire','ไฟไหม้','danger','hospital','lost','urgent','สายด่วน'] },
    { id: 14, part: 1, name: "Feelings & emotions 1", levels: ['beg','li1'], sentences: 35, page: "topic-14a.html", audio: "Feelings_BEG",
      keywords: ['feeling','emotion','อารมณ์','happy','ดีใจ','sad','เสียใจ','angry','โกรธ','tired','เหนื่อย','mood','รู้สึก','scared','worried'] },
    { id: 42, part: 1, name: "Occupations 1", levels: ['beg','li1'], sentences: 30, page: "topic-42a.html", audio: "Occupations_BEG",
      keywords: ['job','occupation','อาชีพ','work','งาน','teacher','ครู','doctor','หมอ','farmer','ชาวนา','profession','police','nurse','engineer'] },
    { id: 11, part: 2, name: "Shopping & money 2", levels: ['beg','li1'], sentences: 30, page: "topic-11b.html", audio: "ShoppingAndMoney2_BEG", access: "premium",
      keywords: ['shopping','money','เงิน','bargain','ต่อรอง','discount','ลด','change','ทอน','market','ตลาด','receipt','pay','จ่าย','cash'] },
    { id: 19, part: 2, name: "Cooking & recipes 2", levels: ['beg','li1'], sentences: 28, page: "topic-19b.html", audio: "Recipes_LI1", access: "premium",
      keywords: ['recipe','สูตร','cooking','ingredient','ส่วนผสม','step','measure','instructions','dish','เมนู','prepare','mix','season'] },
    { id: 18, part: 1, name: "Clothing & appearance 1", levels: ['beg','li1'], sentences: 26, page: "topic-18a.html", audio: "Clothing_BEG", access: "premium",
      keywords: ['clothes','clothing','เสื้อผ้า','shirt','เสื้อ','trousers','กางเกง','shoes','รองเท้า','wear','ใส่','dress','size','fashion'] },
    { id: 18, part: 2, name: "Clothing & appearance 2", levels: ['beg','li1'], sentences: 23, page: "topic-18c.html", audio: "Clothing2_BEG", access: "premium",
      keywords: ['clothes','clothing','เสื้อผ้า','shirt','เสื้อ','trousers','กางเกง','shoes','รองเท้า','wear','ใส่','dress','size','fashion'] },
    { id: 42, part: 2, name: "Occupations 2", levels: ['beg','li1'], sentences: 32, page: "topic-42b.html", audio: "Occupations_LI1", access: "premium",
      keywords: ['job','occupation','อาชีพ','work','career','งาน','skill','profession','employ','duties','role','workplace'] },
    { id: 10, part: 1, name: "Home & daily routine 1", levels: ['beg','li1'], sentences: 32, page: "topic-10a.html", audio: "HomeAndDailyRoutine_BEG", access: "premium",
      keywords: ['home','house','บ้าน','daily routine','wake up','ตื่นนอน','shower','อาบน้ำ','bedroom','ห้องนอน','kitchen','bathroom','ห้องน้ำ','morning','sleep','นอน'] },
    { id: 17, part: 1, name: "Plans & future 1", levels: ['beg','li1'], sentences: 28, page: "topic-17a.html", audio: "Plans_BEG", access: "premium",
      keywords: ['plan','แผน','future','อนาคต','will','จะ','intend','tomorrow','schedule','appointment','นัด','arrange','soon'] },
    { id: 18, part: 3, name: "Clothing & appearance 3", levels: ['beg','li1'], sentences: 21, page: "topic-18b.html", audio: "Appearance_LI1", access: "premium",
      keywords: ['appearance','หน้าตา','look','describe','handsome','หล่อ','beautiful','สวย','hair','ผม','tall','สูง','style','face'] },
    { id: 14, part: 2, name: "Feelings & emotions 2", levels: ['beg','li1'], sentences: 30, page: "topic-14b.html", audio: "Feelings_LI1", access: "premium",
      keywords: ['feeling','emotion','อารมณ์','stress','เครียด','lonely','เหงา','excited','ตื่นเต้น','disappointed','ผิดหวัง','mood','express','empathy'] },
    { id: 10, part: 2, name: "Home & daily routine 2", levels: ['beg','li1'], sentences: 32, page: "topic-10b.html", audio: "HomeAndDailyRoutine2_BEG", access: "premium",
      keywords: ['home','house','บ้าน','housework','chores','งานบ้าน','clean','ทำความสะอาด','laundry','ซักผ้า','wash','routine','tidy','evening'] },
    { id: 16, part: 1, name: "Social life & events 1", levels: ['beg','li1'], sentences: 21, page: "topic-16.html", audio: "SocialLife_BEG", access: "premium",
      keywords: ['social','party','ปาร์ตี้','event','งาน','invite','ชวน','friends','เพื่อน','meet','นัด','celebrate','ฉลอง','birthday','wedding','งานแต่ง'] },

    // ── LOWER → UPPER INTERMEDIATE ──────────────────
    { id: 49, part: 1, name: "Compliments & opinions 1", levels: ['li1','li2'], sentences: 33, page: "topic-49a.html", audio: "Compliments_LI1", access: "premium",
      keywords: ['compliment','ชม','praise','nice','good','เก่ง','well done','flatter','admire','kind words','ชมเชย'] },
    { id: 13, part: 1, name: "Body & health 1", levels: ['li1','li2'], sentences: 26, page: "topic-13a.html", audio: "BodyHealth_BEG", access: "premium",
      keywords: ['body','ร่างกาย','body parts','head','หัว','eye','ตา','ear','หู','hand','มือ','leg','ขา','anatomy','knee','เข่า'] },
    { id: 13, part: 2, name: "Body & health 2", levels: ['li1','li2'], sentences: 30, page: "topic-13b.html", audio: "Health_BEG", access: "premium",
      keywords: ['sick','ill','illness','ป่วย','symptom','อาการ','headache','ปวดหัว','fever','ไข้','cold','หวัด','pharmacy','ยา','medicine','sore throat','pain','ปวด'] },
    { id: 13, part: 3, name: "Body & health 3", levels: ['li1','li2'], sentences: 15, page: "topic-13d.html", audio: "BodyHealth2_BEG", access: "premium",
      keywords: ['body','ร่างกาย','body parts','head','หัว','eye','ตา','ear','หู','hand','มือ','leg','ขา','anatomy','knee','เข่า'] },
    { id: 13, part: 4, name: "Body & health 4", levels: ['li1','li2'], sentences: 27, page: "topic-13c.html", audio: "Health_LI1", access: "premium",
      keywords: ['doctor','หมอ','hospital','โรงพยาบาล','clinic','check up','ตรวจสุขภาพ','appointment','test results','allergy','แพ้ยา','health','wellbeing','treatment'] },
    { id: 49, part: 2, name: "Compliments & opinions 2", levels: ['li1','li2'], sentences: 34, page: "topic-49b.html", audio: "Opinions_LI1", access: "premium",
      keywords: ['opinion','ความเห็น','think','คิด','agree','เห็นด้วย','disagree','argue','view','believe','เชื่อ','discuss','debate'] },
    { id: 36, part: 1, name: "Romantic relationships & dating 1", levels: ['li1','li2'], sentences: 24, page: "topic-36a.html", audio: "Romance_LI1",
      keywords: ['dating','เดท','single','โสด','dating app','แอปหาคู่','swipe','ปัดขวา','match','romance','meet someone','love life'] },
    { id: 36, part: 2, name: "Romantic relationships & dating 2", levels: ['li1','li2'], sentences: 29, page: "topic-36b.html", audio: "Romance2_LI1", access: "premium",
      keywords: ['crush','แอบชอบ','flirt','จีบ','love','รัก','confess','บอกรัก','relationship','แฟน','girlfriend','boyfriend','fall in love','romance'] },
    { id: 36, part: 3, name: "Romantic relationships & dating 3", levels: ['li1','li2'], sentences: 27, page: "topic-36c.html", audio: "Romance3_LI1", access: "premium",
      keywords: ['love','รัก','commitment','soulmate','เนื้อคู่','in laws','marriage','แต่งงาน','devotion','milestone','partner','romance'] },
    { id: 36, part: 4, name: "Romantic relationships & dating 4", levels: ['li1','li2'], sentences: 29, page: "topic-36d.html", audio: "Romance4_LI1", access: "premium",
      keywords: ['jealousy','หึง','trust','ไว้ใจ','argue','ทะเลาะ','fight','เถียง','breakup','เลิก','unfaithful','นอกใจ','conflict','sulk','งอน','romance'] },
    { id: 20, part: 1, name: "Working life 1", levels: ['li1','li2'], sentences: 24, page: "topic-20a.html", audio: "Job_LI1", access: "premium",
      keywords: ['job','work','งาน','apply','สมัคร','interview','สัมภาษณ์','employer','salary','เงินเดือน','hire','resume','working life'] },
    { id: 21, part: 1, name: "Education system 1", levels: ['li1','li2'], sentences: 28, page: "topic-21a.html", audio: "Schooling_LI1", access: "premium",
      keywords: ['education','การศึกษา','school','โรงเรียน','study','เรียน','teacher','ครู','student','นักเรียน','class','subject','วิชา','schooling'] },
    { id: 22, part: 1, name: "Food culture & eating out 1", levels: ['li1','li2'], sentences: 29, page: "topic-22a.html", audio: "FoodSocial_LI1", access: "premium",
      keywords: ['restaurant','ร้านอาหาร','eating out','order','สั่ง','menu','เมนู','waiter','bill','เช็คบิล','table','จอง','food culture','dining'] },
    { id: 24, part: 1, name: "Technology & communication 1", levels: ['li1','li2'], sentences: 24, page: "topic-24a.html", audio: "Tech_LI1",
      keywords: ['technology','เทคโนโลยี','phone','โทรศัพท์','internet','อินเทอร์เน็ต','app','แอป','computer','คอมพิวเตอร์','online','message','ข้อความ','digital'] },
    { id: 23, part: 1, name: "Nature, environment & conservation 1", levels: ['li1','li2'], sentences: 25, page: "topic-23a.html", audio: "Nature_LI1", access: "premium",
      keywords: ['nature','ธรรมชาติ','environment','สิ่งแวดล้อม','tree','ต้นไม้','forest','ป่า','river','แม่น้ำ','mountain','ภูเขา','sea','ทะเล','outdoors'] },
    { id: 45, part: 1, name: "School and University 1", levels: ['li1','li2'], sentences: 28, page: "topic-45a.html", audio: "School_LI1", access: "premium",
      keywords: ['school','โรงเรียน','university','มหาวิทยาลัย','study','เรียน','exam','สอบ','homework','การบ้าน','student','นักศึกษา','class','lecture'] },
    { id: 45, part: 2, name: "School and University 2", levels: ['li1','li2'], sentences: 30, page: "topic-45b.html", audio: "Campus_LI1", access: "premium",
      keywords: ['university','มหาวิทยาลัย','campus','แคมปัส','student life','faculty','คณะ','degree','ปริญญา','dorm','graduate','จบ','lecture'] },
    { id: 27, part: 1, name: "Travel & tourism 1", levels: ['li1','li2'], sentences: 27, page: "topic-27a.html", audio: "Travel_LI1", access: "premium",
      keywords: ['travel','เที่ยว','tourism','ท่องเที่ยว','trip','ทริป','holiday','วันหยุด','hotel','โรงแรม','book','จอง','flight','เครื่องบิน','sightseeing'] },
    { id: 27, part: 2, name: "Travel & tourism 2", levels: ['li1','li2'], sentences: 27, page: "topic-27b.html", audio: "Travel2_LI1", access: "premium",
      keywords: ['travel','เที่ยว','tourism','sightseeing','attraction','สถานที่','beach','ทะเล','island','เกาะ','tour','ทัวร์','guide','itinerary','holiday'] },
    { id: 16, part: 2, name: "Social life & events 2", levels: ['li1','li2'], sentences: 19, page: "topic-16b.html", audio: "SocialLife2_BEG", access: "premium",
      keywords: ['social','party','ปาร์ตี้','event','งาน','invite','ชวน','friends','เพื่อน','meet','นัด','celebrate','ฉลอง','birthday','wedding','งานแต่ง'] },
    { id: 15, part: 1, name: "Hobbies & free time 1", levels: ['li1','li2'], sentences: 19, page: "topic-15.html", audio: "Hobbies_BEG", access: "premium",
      keywords: ['hobby','งานอดิเรก','free time','ว่าง','pastime','interest','relax','พักผ่อน','music','เพลง','read','อ่าน','game','เกม','leisure','weekend'] },   // re-badged by the 2026-07-17 length audit
    { id: 15, part: 2, name: "Hobbies & free time 2", levels: ['li1','li2'], sentences: 18, page: "topic-15b.html", audio: "Hobbies2_BEG", access: "premium",
      keywords: ['hobby','งานอดิเรก','free time','ว่าง','pastime','interest','relax','พักผ่อน','music','เพลง','read','อ่าน','game','เกม','leisure','weekend'] },
    { id: 21, part: 2, name: "Education system 2", levels: ['li1','li2'], sentences: 24, page: "topic-21b.html", audio: "System_LI2", access: "premium",
      keywords: ['education','การศึกษา','system','ระบบ','curriculum','หลักสูตร','exam','สอบ','policy','university','degree','ปริญญา','schooling','reform'] },
    { id: 12, part: 2, name: "Getting around & transport 2", levels: ['li1','li2'], sentences: 26, page: "topic-12b.html", audio: "Transport_LI1", access: "premium",
      keywords: ['transport','travel','getting around','traffic','รถติด','directions','ทาง','route','journey','เดินทาง','driving','ขับรถ','station','สถานี','commute'] },   // re-badged by the 2026-07-17 length audit
    { id: 20, part: 2, name: "Working life 2", levels: ['li1','li2'], sentences: 24, page: "topic-20b.html", audio: "Workplace_LI1", access: "premium",
      keywords: ['workplace','ที่ทำงาน','office','ออฟฟิศ','colleague','เพื่อนร่วมงาน','meeting','ประชุม','boss','เจ้านาย','deadline','email','work'] },
    { id: 17, part: 2, name: "Plans & future 2", levels: ['li1','li2'], sentences: 17, page: "topic-17b.html", audio: "Plans_LI1", access: "premium",
      keywords: ['plan','แผน','future','อนาคต','goal','เป้าหมาย','ambition','dream','ฝัน','long term','intend','prospect','career plan'] },   // re-badged by the 2026-07-17 length audit
    { id: 24, part: 2, name: "Technology & communication 2", levels: ['li1','li2'], sentences: 25, page: "topic-24b.html", audio: "Tech2_LI1", access: "premium",
      keywords: ['technology','เทคโนโลยี','social media','โซเชียล','post','โพสต์','account','บัญชี','password','รหัสผ่าน','wifi','ไวไฟ','device','digital'] },
    { id: 24, part: 3, name: "Technology & communication 3", levels: ['li1','li2'], sentences: 24, page: "topic-24c.html", audio: "Tech3_LI1", access: "premium",
      keywords: ['technology','เทคโนโลยี','ai','online','scam','หลอกลวง','privacy','ความเป็นส่วนตัว','data','ข้อมูล','software','update','digital','future tech'] },
    { id: 26, part: 1, name: "Sport & exercise 1", levels: ['li1','li2'], sentences: 26, page: "topic-26a.html", audio: "Sport_LI1", access: "premium",
      keywords: ['sport','กีฬา','exercise','ออกกำลังกาย','football','ฟุตบอล','run','วิ่ง','gym','ยิม','play','เล่น','fitness','swim','ว่ายน้ำ'] },
    { id: 47, part: 1, name: "Homes & housing 1", levels: ['li1','li2'], sentences: 16, page: "topic-47.html", audio: "HomesAndHousing_LI1", access: "premium",
      keywords: ['house','บ้าน','housing','rent','เช่า','condo','คอนโด','apartment','อพาร์ตเมนต์','landlord','เจ้าของบ้าน','move','ย้าย','property','lease','deposit'] },
    { id: 48, part: 1, name: "Household supplies 1", levels: ['li1','li2'], sentences: 18, page: "topic-48.html", audio: "HouseholdSupplies_BEG", access: "premium",
      keywords: ['household','supplies','ของใช้','soap','สบู่','detergent','ผงซักฟอก','tissue','cleaning','shop','ร้าน','home goods','toiletries','แชมพู'] },
    { id: 48, part: 2, name: "Household supplies 2", levels: ['li1','li2'], sentences: 19, page: "topic-48b.html", audio: "HouseholdSupplies2_BEG", access: "premium",
      keywords: ['household','supplies','ของใช้','soap','สบู่','detergent','ผงซักฟอก','tissue','cleaning','shop','ร้าน','home goods','toiletries','แชมพู'] },
    { id: 26, part: 2, name: "Sport & exercise 2", levels: ['li1','li2'], sentences: 26, page: "topic-26b.html", audio: "Sport_LI2", access: "premium",
      keywords: ['sport','กีฬา','exercise','competition','แข่ง','team','ทีม','match','training','ฝึก','muay thai','มวยไทย','athlete','นักกีฬา','fitness'] },
    { id: 23, part: 2, name: "Nature, environment & conservation 2", levels: ['li1','li2'], sentences: 18, page: "topic-23c.html", audio: "Nature2_LI1", access: "premium",
      keywords: ['nature','ธรรมชาติ','environment','สิ่งแวดล้อม','tree','ต้นไม้','forest','ป่า','river','แม่น้ำ','mountain','ภูเขา','sea','ทะเล','outdoors'] },
    { id: 34, part: 1, name: "Thai culture & customs 1", levels: ['li1','li2'], sentences: 22, page: "topic-34a.html", audio: "ThaiCulture_LI1",
      keywords: ['thai culture','วัฒนธรรม','custom','ประเพณี','tradition','wai','ไหว้','respect','เคารพ','etiquette','มารยาท','manners','face','เกรงใจ'] },
    { id: 29, part: 1, name: "Community & society 1", levels: ['li1','li2'], sentences: 21, page: "topic-29a.html", audio: "Community_LI1", access: "premium",
      keywords: ['community','ชุมชน','society','สังคม','neighbour','เพื่อนบ้าน','village','หมู่บ้าน','local','volunteer','อาสา','help','public'] },
    { id: 29, part: 2, name: "Community & society 2", levels: ['li1','li2'], sentences: 20, page: "topic-29c.html", audio: "Community2_LI1", access: "premium",
      keywords: ['community','ชุมชน','society','สังคม','neighbour','เพื่อนบ้าน','village','หมู่บ้าน','local','volunteer','อาสา','help','public'] },
    { id: 20, part: 3, name: "Working life 3", levels: ['li1','li2'], sentences: 24, page: "topic-20c.html", audio: "Career_LI2", access: "premium",
      keywords: ['career','อาชีพ','promotion','เลื่อนตำแหน่ง','ambition','resign','ลาออก','experience','ประสบการณ์','professional','work','development'] },
    { id: 27, part: 3, name: "Travel & tourism 3", levels: ['li1','li2'], sentences: 25, page: "topic-27c.html", audio: "Travel_LI2", access: "premium",
      keywords: ['travel','เที่ยว','tourism','ท่องเที่ยว','abroad','ต่างประเทศ','visa','วีซ่า','culture shock','backpack','trip','airport','สนามบิน','journey'] },
    { id: 23, part: 3, name: "Nature, environment & conservation 3", levels: ['li1','li2'], sentences: 21, page: "topic-23b.html", audio: "Nature_LI2", access: "premium",
      keywords: ['environment','สิ่งแวดล้อม','conservation','อนุรักษ์','pollution','มลพิษ','recycle','รีไซเคิล','climate','โลกร้อน','waste','ขยะ','nature','sustainability','wildlife'] },
    { id: 34, part: 2, name: "Thai culture & customs 2", levels: ['li1','li2'], sentences: 23, page: "topic-34b.html", audio: "ThaiCulture_LI2", access: "premium",
      keywords: ['thai culture','วัฒนธรรม','custom','ประเพณี','tradition','festival','เทศกาล','songkran','สงกรานต์','loy krathong','ลอยกระทง','belief','ความเชื่อ','superstition'] },
    { id: 22, part: 2, name: "Food culture & eating out 2", levels: ['li1','li2'], sentences: 23, page: "topic-22b.html", audio: "FoodCulture_LI2", access: "premium",
      keywords: ['food culture','อาหาร','cuisine','regional','ภาค','street food','สตรีทฟู้ด','dish','เมนู','flavour','รสชาติ','eating out','tradition','isaan','อีสาน'] },
    { id: 32, part: 1, name: "Thai geography & regions 1", levels: ['li1','li2'], sentences: 21, page: "topic-32a.html", audio: "GeoRegions_LI1", access: "premium",
      keywords: ['geography','ภูมิศาสตร์','region','ภาค','province','จังหวัด','thailand','ประเทศไทย','north','เหนือ','south','ใต้','map','area','isaan','อีสาน'] },
    { id: 25, part: 1, name: "Media & entertainment 1", levels: ['li1','li2'], sentences: 17, page: "topic-25a.html", audio: "Media_LI1", access: "premium",
      keywords: ['media','สื่อ','entertainment','บันเทิง','tv','ทีวี','film','หนัง','movie','music','เพลง','series','ละคร','watch','ดู','show'] },
    { id: 25, part: 2, name: "Media & entertainment 2", levels: ['li1','li2'], sentences: 20, page: "topic-25c.html", audio: "Media3_LI1", access: "premium",
      keywords: ['media','สื่อ','entertainment','บันเทิง','tv','ทีวี','film','หนัง','movie','music','เพลง','series','ละคร','watch','ดู','show'] },
    { id: 47, part: 2, name: "Homes & housing 2", levels: ['li1','li2'], sentences: 13, page: "topic-47b.html", audio: "HomesAndHousing2_LI1", access: "premium",
      keywords: ['house','บ้าน','housing','rent','เช่า','condo','คอนโด','apartment','อพาร์ตเมนต์','landlord','เจ้าของบ้าน','move','ย้าย','property','lease','deposit'] },

    // ── UPPER INTERMEDIATE → ADVANCED ───────────────
    { id: 35, part: 1, name: "Buddhism 1", levels: ['li2','adv'], sentences: 21, page: "topic-35a.html", audio: "Temple_LI1",
      keywords: ['buddhism','พุทธ','temple','วัด','monk','พระ','merit','ทำบุญ','offering','ใส่บาตร','pray','religion','ศาสนา','shrine'] },
    { id: 35, part: 2, name: "Buddhism 2", levels: ['li2','adv'], sentences: 18, page: "topic-35b.html", audio: "HolyDays_LI1", access: "premium",
      keywords: ['buddhism','พุทธ','holy day','วันพระ','festival','เทศกาล','ceremony','พิธี','vesak','วิสาขบูชา','religion','ศาสนา','observance','lent','เข้าพรรษา'] },
    { id: 29, part: 3, name: "Community & society 3", levels: ['li2','adv'], sentences: 19, page: "topic-29b.html", audio: "Community_LI2", access: "premium",
      keywords: ['society','สังคม','community','ชุมชน','inequality','เหลื่อมล้ำ','social issue','ปัญหาสังคม','welfare','public','politics','การเมือง','citizen','civic'] },   // re-badged by the 2026-07-17 length audit
    { id: 35, part: 3, name: "Buddhism 3", levels: ['li2','adv'], sentences: 19, page: "topic-35c.html", audio: "Dhamma_LI2", access: "premium",
      keywords: ['buddhism','พุทธ','dhamma','ธรรมะ','teaching','คำสอน','karma','กรรม','precept','ศีล','philosophy','ปรัชญา','religion','doctrine'] },
    { id: 35, part: 4, name: "Buddhism 4", levels: ['li2','adv'], sentences: 13, page: "topic-35f.html", audio: "Meditation2_LI2", access: "premium",
      keywords: ['meditation','สมาธิ','buddhism','พุทธ','mindfulness','สติ','vipassana','วิปัสสนา','retreat','breathe','calm','สงบ','practice','religion'] },
    { id: 35, part: 5, name: "Buddhism 5", levels: ['li2','adv'], sentences: 15, page: "topic-35e.html", audio: "Monastic_LI2", access: "premium",
      keywords: ['monastic','สงฆ์','monk','พระ','ordination','บวช','temple','วัด','monastery','robe','จีวร','buddhism','พุทธ','religion','novice','เณร'] },
    { id: 35, part: 6, name: "Buddhism 6", levels: ['li2','adv'], sentences: 15, page: "topic-35g.html", audio: "Monastic2_LI2", access: "premium",
      keywords: ['monastic','สงฆ์','monk','พระ','ordination','บวช','temple','วัด','monastery','robe','จีวร','buddhism','พุทธ','religion','novice','เณร'] },
    { id: 32, part: 2, name: "Thai geography & regions 2", levels: ['li2','adv'], sentences: 16, page: "topic-32c.html", audio: "GeoRegions2_LI1", access: "premium",
      keywords: ['geography','ภูมิศาสตร์','region','ภาค','province','จังหวัด','thailand','ประเทศไทย','north','เหนือ','south','ใต้','map','area','isaan','อีสาน'] },
    { id: 25, part: 3, name: "Media & entertainment 3", levels: ['li2','adv'], sentences: 15, page: "topic-25b.html", audio: "Media2_LI1", access: "premium",
      keywords: ['media','สื่อ','entertainment','บันเทิง','news','ข่าว','celebrity','ดารา','journalism','นักข่าว','critique','review','วิจารณ์','industry'] },   // re-badged by the 2026-07-17 length audit
    { id: 35, part: 7, name: "Buddhism 7", levels: ['li2','adv'], sentences: 10, page: "topic-35d.html", audio: "Meditation_LI2", access: "premium",
      keywords: ['meditation','สมาธิ','buddhism','พุทธ','mindfulness','สติ','vipassana','วิปัสสนา','retreat','breathe','calm','สงบ','practice','religion'] },
    { id: 32, part: 3, name: "Thai geography & regions 3", levels: ['li2','adv'], sentences: 16, page: "topic-32b.html", audio: "GeoRegions_LI2", access: "premium",
      keywords: ['geography','ภูมิศาสตร์','region','ภาค','province','จังหวัด','landscape','climate','ภูมิอากาศ','terrain','border','ชายแดน','thailand','economy','resources'] },   // re-badged by the 2026-07-17 length audit
    { id: 25, part: 4, name: "Media & entertainment 4", levels: ['li2','adv'], sentences: 14, page: "topic-25d.html", audio: "Media4_LI1", access: "premium",
      keywords: ['media','สื่อ','entertainment','บันเทิง','news','ข่าว','celebrity','ดารา','journalism','นักข่าว','critique','review','วิจารณ์','industry'] },

    // ── COMING SOON (not built: no page/audio → rendered as the compact list, not cards) ──
    { id: 28, name: "Banking & finance", levels: ['li1','li2'], sentences: 25, access: "premium",
      keywords: ['bank','ธนาคาร','finance','money','เงิน','account','บัญชี','atm','transfer','โอน','loan','savings','interest'] },
    { id: 30, name: "Agriculture & rural life", levels: ['li1','li2'], sentences: 25, access: "premium",
      keywords: ['agriculture','เกษตร','farm','ฟาร์ม','rice','ข้าว','rural','ชนบท','crop','พืช','farmer','ชาวนา','harvest','เก็บเกี่ยว','village'] },
    { id: 31, name: "Crime, law & justice", levels: ['li1','li2'], sentences: 25, access: "premium",
      keywords: ['crime','อาชญากรรม','law','กฎหมาย','justice','ยุติธรรม','police','ตำรวจ','court','ศาล','lawyer','ทนาย','arrest','จับ','prison','คุก'] },
    { id: 33, name: "Ceremonies & rites of passage", levels: ['li1','li2'], sentences: 25, access: "premium",
      keywords: ['ceremony','พิธี','rites','ประเพณี','wedding','งานแต่ง','funeral','งานศพ','ordination','บวช','birth','ritual','tradition','milestone'] },
    { id: 43, name: "Muay Thai", levels: ['li1','li2'], access: "premium",
      keywords: ['muay thai','มวยไทย','boxing','ชก','fight','แข่ง','ring','เวที','training','ฝึก','kick','เตะ','martial arts','sport','กีฬา'] },
    { id: 44, name: "Humour", levels: ['beg','li1'], access: "premium",
      keywords: ['humour','humor','ตลก','joke','มุก','funny','ขำ','laugh','หัวเราะ','comedy','pun','เล่นคำ','wit','banter'] },
  ];

  // ---- back-compat: a derived {id: page} map for NON-split units --------------------
  // The old hand-maintained liveTopics map is gone (it had stale entries pointing at
  // files that never existed, e.g. topic-04/10/11.html). "Live" is now simply: the unit
  // has a page. This is derived so it can never drift.
  const liveTopics = {};
  topics.forEach(function (u) { if (u.page && !u.part) liveTopics[u.id] = u.page; });

  function isLive(u) { return !!u.page; }
  // Distinct TOPICS that are live (not units) — the hero "Topics" stat counts topics,
  // so a 2-part topic counts once.
  function liveTopicCount() {
    const s = {};
    topics.forEach(function (u) { if (u.page) s[u.id] = 1; });
    return Object.keys(s).length;
  }

  // Level order + labels. `adv` (Advanced) is the tertiary tier — niche / highly
  // specialised units whose sentences are a genuine step up (e.g. Buddhism).
  const LEVEL_ORDER = ['beg', 'li1', 'li2', 'adv'];
  const LEVEL_CLASS = { beg: 'badge-beg', li1: 'badge-li1', li2: 'badge-li2', adv: 'badge-adv' };
  const LEVEL_FULL  = { beg: 'Beginner', li1: 'Lower intermediate', li2: 'Upper intermediate', adv: 'Advanced' };
  // User-facing labels are NEVER abbreviated — "Lower int" is internal shorthand only.
  const LEVEL_SHORT = { beg: 'Beginner', li1: 'Lower intermediate', li2: 'Upper intermediate', adv: 'Advanced' };

  function levelBounds(levels) {
    const present = LEVEL_ORDER.filter(l => levels.includes(l));
    return [present[0], present[present.length - 1]]; // [floor, ceiling]
  }
  // Plain text of the level label, e.g. "Beginner" or "Beginner → Lower intermediate".
  // Both the index badge AND the topic-page eyebrow use this — so they always match.
  function levelText(levels) {
    const [floor, ceiling] = levelBounds(levels);
    return floor === ceiling
      ? LEVEL_FULL[floor]
      : `${LEVEL_SHORT[floor]} → ${LEVEL_SHORT[ceiling]}`;
  }
  function levelBadge(levels) {
    const [floor] = levelBounds(levels);
    return `<div class="level-badges"><span class="level-badge ${LEVEL_CLASS[floor]}">${levelText(levels)}</span></div>`;
  }
  // A filter tab matches when its level lies WITHIN the unit's [floor, ceiling] range.
  function matchesFilter(levels, filter) {
    if (filter === 'all') return true;
    const [floor, ceiling] = levelBounds(levels);
    const f = LEVEL_ORDER.indexOf(filter);
    return f >= LEVEL_ORDER.indexOf(floor) && f <= LEVEL_ORDER.indexOf(ceiling);
  }

  // Find the unit whose page == filename, plus its 1-based display position.
  // Compare WITHOUT the .html extension — Cloudflare Pages serves clean URLs
  // (location is /topic-03, not /topic-03.html), so we must match either form.
  // Returns { pos, topic, unit, part } — `topic`/`part` kept for back-compat with
  // callers written against the old nested shape.
  function bare(f) { return String(f || '').toLowerCase().replace(/\.html$/, ''); }

  /* ⚠ EVERY LINK TO A TOPIC PAGE MUST GO THROUGH hrefFor() (2026-08-12).
     `page` stays "topic-NN.html" — it is the identity key (findByPage/pageUnit/bareP all normalise
     through bare(), and index.html keys the `thaiear-dl` download cache off it). But the HREF must
     be the CLEAN url, because Cloudflare Pages 308-redirects /topic-NN.html → /topic-NN and that
     redirect is `cf-cache-status: DYNAMIC` — a full, uncached origin round trip.
     Measured live: 127–1315 ms per topic open (median ~0.6 s by curl), roughly DOUBLING TTFB. And
     `workerStart` lands AFTER `redirectEnd`, so it runs before the service worker even starts —
     Navigation Preload (sw v293) cannot cover it. It was dead time in front of every optimisation
     already made, and its variance is a large part of why opening a topic felt "sometimes fast,
     sometimes slow".
     The .html URLs keep working (Pages still 308s them), so old bookmarks and inbound links are
     unaffected — this only stops US paying the hop on every internal click. */
  /* ⚠ LOCALHOST KEEPS THE .html. `python -m http.server` (the local review server — see the
     SW-unregister-on-localhost rule in nav.js) has no clean-URL resolution, so /topic-01 would 404
     on every card click during a review session. Normalise to bare first, then re-add on a local
     host, so this one function always returns "the href that works on THIS host" — which is why
     the generated static links can be bare and callers can pass either form. */
  const LOCAL_HOST = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/
    .test(location.hostname);
  function hrefFor(p) {
    const s = String(p || '').replace(/\.html$/i, '');
    return (LOCAL_HOST && s) ? s + '.html' : s;
  }

  function findByPage(file) {
    file = bare(file);
    for (let i = 0; i < topics.length; i++) {
      const u = topics[i];
      if (u.page && bare(u.page) === file) return { pos: i + 1, topic: u, unit: u, part: null };
    }
    return null;
  }

  // ---- access tiers (free / member / premium) ----------------------------------
  // ENFORCE_SUBSCRIPTION gates the premium check: while false, premium behaves like
  // member (signed-in is enough). Real enforcement is server-side; this drives UX.
  const ENFORCE_SUBSCRIPTION = true;
  function authState() {
    const a = window.ThaiEarAuth || {};
    return {
      loggedIn: !!(a.getUser && a.getUser()),
      subscribed: !!(a.isSubscribed && a.isSubscribed()),
    };
  }
  // Effective access for a unit. Second arg is ignored — kept so old two-arg callers
  // accessFor(topic, part) keep working against the flat model.
  function accessFor(unit, _part) {
    return (unit && unit.access) || 'free';
  }
  /* ⚠ THE LIVE TIER FOR AN AUDIO PREFIX — the ONE answer to "which bucket is this clip in".
     A playlist item stores its own `tier` alongside the sentence text (playlist_items.tier), and
     that snapshot is taken when the sentence is SAVED. A tier change is therefore invisible to it
     forever — but the tier is not decoration, it is a ROUTING decision: 'member'/'premium' fetches
     a signed URL against the PRIVATE bucket, 'free' hits the public CDN. When the 9 former-member
     first-parts were demoted to free on 2026-08-10 their MP3s MOVED to the public bucket, so every
     saved playlist row still claiming 'member' asked the gate to sign a URL for an object that is
     no longer there: a hard 404 on every download attempt and every session build, unfixable by
     retrying (owner hit it on ShoppingAndMoney_BEG_S323, 2026-08-13). The topic page never saw it
     because it reads its own page-level `tier`, which ships with the deploy.
     So: routing reads THIS, never the snapshot. Returns null for a prefix this list doesn't know
     (a retired or renamed unit) so the caller can fall back to the stored value rather than
     silently downgrading an unknown clip to free. */
  function tierForPrefix(prefix) {
    if (!prefix) return null;
    for (let i = 0; i < topics.length; i++) {
      if (topics[i].audio === prefix) return accessFor(topics[i]);
    }
    return null;
  }

  /* ── PLAY-COUNT ROLL-UP (PLAYS_COUNTER.md §2) ─────────────────────────────────
     The single number a topic card or playlist row shows. Lives HERE, not in the three call
     sites, because index.html, pl-list.js and player.js must never be able to disagree about it.

     THE RULE: the MINIMUM play count across the unit's sentences. That is what makes it mean
     "complete listens" — it only moves when the LEAST-heard sentence moves.

     ⚠ Two kinds of sentence are SKIPPED when taking that minimum, both for the same reason: a
     sentence the user cannot or will not play would pin the number at 0 for ever.
        · EXCLUDED — the user took it out of their session (te_dyn_excl_<prefix>).
        · LOCKED   — premium content they are not entitled to; they could never move it.

     ⚠⚠ UNLESS SKIPPING WOULD LEAVE NOTHING. If every sentence is excluded or locked, they ALL
     count again. The filter is a FALLBACK, not an absolute: the owner's rule is that this must
     always produce a real number, never a dash. Deleting the `if (!pool.length)` line looks like
     a tidy-up and silently turns a fully-excluded topic into a blank.

     `nums`     — every global sentence number in the unit (topic-sentences.json, or a playlist's
                  own items).
     `counts`   — ThaiEarAuth.getPlays().
     `skip`     — optional predicate(num) -> true to leave it out. */
  function playsMin(nums, counts, skip) {
    if (!nums || !nums.length) return 0;
    let pool = nums;
    if (skip) {
      const kept = nums.filter(n => !skip(n));
      // ⚠ THE FALLBACK. See the note above before "simplifying" this away.
      if (kept.length) pool = kept;
    }
    let min = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = (counts && counts[String(pool[i])]) || 0;
      if (c < min) min = c;
      if (min === 0) return 0;          // cannot go lower — stop early
    }
    return min === Infinity ? 0 : min;
  }

  /* The excluded set for a unit, read from the SAME localStorage key player.js writes
     (`te_dyn_excl_<dynKey>`, and a topic page's dynKey falls back to its audio prefix — which is
     exactly what the index card already carries in data-audio). So the index needs no new
     plumbing and no network call to honour exclusions.
     ⚠ Playlists have no exclusion UI (round-11), so this is topic-only by construction. */
  function exclFor(audioPrefix) {
    if (!audioPrefix) return null;
    try {
      const raw = localStorage.getItem('te_dyn_excl_' + audioPrefix);
      if (!raw) return null;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr) || !arr.length) return null;
      const set = Object.create(null);
      arr.forEach(n => { set[String(n)] = 1; });
      return set;
    } catch (_) { return null; }
  }

  /* Fetch the unit -> sentence-numbers lookup, once. ONLY the index needs it: a topic page
     already has its own sentences, and a playlist carries its own items. So this is deliberately
     lazy rather than loaded by topics.js on every page — it is 11 KB that 93 of 95 pages would
     never read. Resolves to the map (or null) and never rejects.
     The file is generated by gen_topic_sentences.js and is in sw.js PRECACHE, so offline it comes
     straight from the cache. */
  let sentenceNumsPromise = null;
  function loadSentenceNums() {
    if (window.ThaiEarSentenceNums) return Promise.resolve(window.ThaiEarSentenceNums);
    if (sentenceNumsPromise) return sentenceNumsPromise;
    sentenceNumsPromise = fetch('topic-sentences.json')
      .then(r => (r.ok ? r.json() : null))
      .then(m => { if (m) window.ThaiEarSentenceNums = m; return m || null; })
      .catch(() => null);
    return sentenceNumsPromise;
  }

  /* The finished caption for a topic card. Returns '' when there is nothing to show — signed
     out, or the lookup has not loaded — so a caller can concatenate it unconditionally.
     ⚠ Shown even at 0, unlike the sentence pill: on a card, zero is the meaningful
     "not started yet" signal (owner, 2026-08-20). */
  function playsCaptionFor(page, audioPrefix) {
    const A = window.ThaiEarAuth;
    if (!A || !A.getUser || !A.getUser() || !A.getPlays) return '';
    const map = window.ThaiEarSentenceNums;
    if (!map) return '';
    const nums = map[bare(page)];
    if (!nums || !nums.length) return '';
    const excl = exclFor(audioPrefix);
    const n = playsMin(nums, A.getPlays(), excl ? (num => !!excl[String(num)]) : null);
    return 'Plays: ' + n;
  }

  // Can the current visitor open this unit? (drives card links + prev/next unlock)
  function canAccess(access) {
    if (access === 'premium') {
      const s = authState();
      return ENFORCE_SUBSCRIPTION ? s.subscribed : s.loggedIn;
    }
    if (access === 'member') return authState().loggedIn;
    return true; // free / undefined
  }

  // ---- SEARCH -----------------------------------------------------------------------
  // Ranked, thresholded, capped — NOT a filter. The rules that keep it precise:
  //   1. AND, never OR: EVERY typed token must score against the same unit. This is the
  //      single thing that stops "food market" returning everything food + everything
  //      market. Tokens narrow, never widen.
  //   2. No fuzzy / edit-distance matching — that is exactly what makes a search feel
  //      broad and wrong. Prefix matching already gives cook -> cooking.
  //   3. Single-char tokens are ignored (stops "a" matching everything).
  //   4. Hard cap + score floor, so even a pathological query can't flood the grid.
  const SEARCH_CAP = 12, SEARCH_FLOOR = 25;
  function norm(s) { return String(s || '').toLowerCase().trim(); }
  // "&" and "and" are the SAME word here. Most topic names use an ampersand ("Food & drink 2"),
  // but people type what they say — "food and drink 2" — and used to get zero results, which
  // reads as "that topic doesn't exist". Expanding & -> " and " on BOTH sides (names, keywords
  // and the query) makes the two spellings interchangeable, so "food and drink 2", "food & drink 2"
  // and "food&drink 2" all land on the same card.
  function expand(s) { return norm(s).replace(/&/g, ' and ').replace(/\s+/g, ' ').trim(); }
  // Tokens: drop 1-char noise ("a" would match everything) but KEEP single DIGITS, so the part
  // number in "food and drink 2" is a real, narrowing token rather than silently discarded.
  function tokenize(q) {
    return expand(q).split(/[\s,]+/).filter(t => t.length > 1 || /^[0-9]$/.test(t));
  }

  // Score ONE token against ONE unit. 0 = no match (which kills the whole unit, by AND).
  function scoreToken(u, tok) {
    const name = expand(u.name);              // "Food & drink 2" -> "food and drink 2"
    if (name === tok) return 100;
    if (name.indexOf(tok) === 0) return 80;
    // word-start inside the name, e.g. "trans" -> "Getting around & transport 1"
    if (new RegExp('(^|[^a-z0-9฀-๿])' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(name)) return 60;
    if (name.indexOf(tok) !== -1) return 45;
    let best = 0;
    for (const k of (u.keywords || [])) {
      const kw = expand(k);
      if (kw === tok) { best = Math.max(best, 40); continue; }
      if (kw.indexOf(tok) === 0) best = Math.max(best, 25);
    }
    return best;
    // NOTE: keyword matching is exact-or-PREFIX only — deliberately never "contains".
    // Thai writes without spaces, so a substring test makes short Thai words match inside
    // unrelated longer ones: วัด (temple) would hit หวัด (a cold) and จังหวัด (province),
    // returning Body & health and Thai geography for a temple search. Prefix-only keeps
    // วัด → Buddhism / Places around town, which is what the user meant.
  }

  // Search the units. `pool` lets the caller pre-restrict to whatever the filter pills
  // currently allow, so search can never surface a topic the pills exclude.
  // Returns [{ unit, pos, score }] best-first, capped.
  function searchUnits(query, pool) {
    const toks = tokenize(query);
    if (!toks.length) return null;                 // null = "not searching" (≠ no results)
    const list = pool || topics.map((u, i) => ({ u, pos: i + 1 }));
    const hits = [];
    for (const item of list) {
      const u = item.u || item;
      const pos = item.pos;
      let total = 0, ok = true;
      for (const t of toks) {
        const s = scoreToken(u, t);
        if (!s) { ok = false; break; }             // AND: one miss disqualifies the unit
        total += s;
      }
      if (ok && total >= SEARCH_FLOOR) hits.push({ unit: u, pos: pos, score: total });
    }
    hits.sort((a, b) => b.score - a.score || a.pos - b.pos);
    return hits.slice(0, SEARCH_CAP);
  }

  // ---- continuous-playback sequence (drives the player's autoplay + prev/next) -------
  // A "unit" here is one playable page. Built straight from the list so it stays a
  // single source of truth. A unit must have BOTH a page and an `audio` prefix.
  function unitOf(u, pos) {
    return {
      pos: pos, id: u.id, part: u.part || null,
      page: u.page, name: u.name, audio: u.audio,
      access: accessFor(u), levels: u.levels
    };
  }
  // All live, playable units in DISPLAY order.
  function liveSequence() {
    const seq = [];
    for (let i = 0; i < topics.length; i++) {
      const u = topics[i];
      if (u.page && u.audio) seq.push(unitOf(u, i + 1));
    }
    return seq;
  }
  // The unit for a given page (null if the page isn't a live, playable unit).
  function pageUnit(page) {
    page = bare(page);
    const seq = liveSequence();
    for (let i = 0; i < seq.length; i++) if (bare(seq[i].page) === page) return seq[i];
    return null;
  }
  // Walk the sequence from `page` in `dir` (+1 next / -1 prev), wrapping last<->first,
  // skipping any unit the current visitor can't access.
  function nextAccessible(page, dir) {
    const seq = liveSequence();
    if (!seq.length) return null;
    const p = bare(page);
    let idx = -1;
    for (let i = 0; i < seq.length; i++) if (bare(seq[i].page) === p) { idx = i; break; }
    if (idx === -1) return null;
    const n = seq.length;
    for (let step = 1; step <= n; step++) {
      const j = ((idx + dir * step) % n + n) % n;
      // Offline, a downloaded topic counts as accessible (the in-page player can use its local audio).
      if (canAccess(seq[j].access) || (!navigator.onLine && offlineHas(seq[j].audio))) return seq[j];
    }
    return seq[idx]; // nothing else accessible — stay put
  }

  // Shared surface for index.html (grid render) and anything else that needs the data.
  window.ThaiEarTopics = {
    topics, liveTopics, total: topics.length,
    isLive, liveTopicCount,
    LEVEL_ORDER, LEVEL_CLASS, LEVEL_FULL, LEVEL_SHORT,
    levelBounds, levelText, levelBadge, matchesFilter, findByPage,
    canAccess, accessFor, tierForPrefix, authState, ENFORCE_SUBSCRIPTION,
    playsMin, exclFor, playsCaptionFor, loadSentenceNums,   // play-count roll-up — ONE implementation, three call sites
    liveSequence, pageUnit, nextAccessible,
    searchUnits, tokenize,
    hrefFor   // ⚠ every emitted topic link goes through this — see the note above hrefFor()
  };

  // ---- topic-page eyebrow: the difficulty (e.g. "BEGINNER"), derived from the list ----
  function currentPage() {
    return (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  }
  function fillEyebrow() {
    const el = document.getElementById('topic-eyebrow');
    if (!el) return; // not a topic page (e.g. index) — nothing to fill
    const found = findByPage(currentPage());
    if (!found) return; // page not in the list yet — leave the element as-is
    el.textContent = levelText(found.unit.levels);
  }

  // ---- prev/next nav: normalise each button's destination (no padlocks — gating is object-level) ----
  let navStylesInjected = false;
  function injectNavLockStyles() {
    if (navStylesInjected) return; navStylesInjected = true;
    const s = document.createElement('style');
    s.textContent =
      '.topic-nav-btn.nav-to-premium:hover{background:#FBF5DC;border-color:var(--gold-dark)}';
    (document.head || document.documentElement).appendChild(s);
  }
  // The button's real destination page, stored once on data-target so it survives re-runs.
  function navTarget(a) {
    let t = a.getAttribute('data-target') || a.getAttribute('data-locked-href') || a.getAttribute('href');
    if (t && !a.getAttribute('data-target')) a.setAttribute('data-target', t);
    return t;
  }
  // access of the unit a button points INTO; null if it isn't a topic page (skip it).
  function navAccessFor(target) {
    const found = findByPage(target || '');
    return found ? accessFor(found.unit) : null;
  }
  // Is a unit's audio prefix present in the offline-download manifest?
  function offlineHas(prefix) {
    if (!prefix) return false;
    try { return !!JSON.parse(localStorage.getItem('thaiear_offline') || '{}')[prefix]; } catch (_) { return false; }
  }
  // The audio prefix for a target page (to check the offline manifest).
  function navAudioFor(target) {
    const found = findByPage(target || '');
    return found ? (found.unit.audio || null) : null;
  }
  function decorateNavBtn(a) {
    const target = navTarget(a);
    const access = navAccessFor(target);
    if (access === null) return; // not a topic link (e.g. back-to-index) — leave alone
    injectNavLockStyles();
    a.classList.toggle('nav-to-premium', access === 'premium');
    const nameEl = a.querySelector('.topic-nav-name');
    const oldIcon = a.querySelector('.topic-nav-lock'); if (oldIcon) oldIcon.remove();
    if (nameEl) nameEl.textContent = nameEl.textContent.replace(/^\s*🔒\s*/, ''); // drop legacy emoji
    // Offline, a downloaded destination is reachable (its page is cached + audio is local).
    const downloadedOffline = !navigator.onLine && offlineHas(navAudioFor(target));
    if (access === 'free' || canAccess(access) || downloadedOffline) { // open / entitled / offline-download → unlocked
      a.setAttribute('href', hrefFor(target));
      a.removeAttribute('data-locked-href');
      return;
    }
    // Navigable-preview model: gated topics are still reachable by anyone — point prev/next at the
    // REAL page (never the paywall). The padlock icon still signals the tier; the on-page gating
    // (reveal/flag/play) enforces the actual restriction.
    a.setAttribute('href', hrefFor(target));
    a.removeAttribute('data-locked-href');
    // r98: no padlock icon on prev/next — any user can open any page; gating is object-level
    // (audio/reveal/flag on the page itself), so the buttons carry no tier signal (owner, 2026-08-01).
  }
  function decorateTopicNav() {
    document.querySelectorAll('a.topic-nav-btn').forEach(function (a) {
      if (!a.classList.contains('disabled')) decorateNavBtn(a);
    });
  }
  window.addEventListener('thaiear:auth', decorateTopicNav); // re-run when login resolves/changes
  window.addEventListener('online', decorateTopicNav);       // offline-download unlock follows connectivity
  window.addEventListener('offline', decorateTopicNav);

  // Click-time safety net (auth is always resolved by click; covers cached/late-auth pages).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest ? e.target.closest('a.topic-nav-btn[data-target]') : null;
    if (!a) return;
    const target = a.getAttribute('data-target');
    const access = navAccessFor(target);
    const entitled = access !== null && (access === 'free' || canAccess(access));
    // Compare against the host-correct href, not the raw data-target, or this "correction" would
    // fire on every click and re-introduce the .html → clean 308 it exists to avoid.
    if (entitled && a.getAttribute('href') !== hrefFor(target)) { // stale gate href → correct it
      e.preventDefault();
      window.location.href = hrefFor(target);
    }
  });

  function init() { fillEyebrow(); decorateTopicNav(); }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
