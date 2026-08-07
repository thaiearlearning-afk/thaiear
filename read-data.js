/* ============================================================
   read-data.js — SINGLE SOURCE for the "Read Thai" section.
   ------------------------------------------------------------
   Everything the reading pages render — consonants, vowels,
   tone rules, quiz words — plus every TTS input line for
   generate_read_audio.py (which parses the JSON body of this
   file). Audio files live in read-audio/{audio}.mp3, with
   "-word" / "-ex" suffixed clips for the name-words / examples.

   Transliteration tone accents (shown to learners on read.html):
     á = high · à = low · â = falling · ǎ = rising · a = mid
   ============================================================ */
window.ThaiEarRead = {
  "sections": [
    { "key": "mid",      "kind": "letters", "title": "Mid-class consonants",  "short": "Mid class",
      "page": "read-mid.html",
      "blurb": "9 letters",
      "intro": "These 9 letters are the mid class consonants. Every mid-class letter's name starts on a plain mid tone: gaw, jaw, daw, dtaw. Two sounds here don't exist in English: ต dtaw is a hard, unaspirated t (between English t and d), and ป bpaw is the same idea for p. อ aw is special — it's a silent consonant that carries vowels, and doubles as the vowel sound aw." },
    { "key": "high",     "kind": "letters", "title": "High-class consonants", "short": "High class",
      "page": "read-high.html",
      "blurb": "10 letters",
      "intro": "The 10 high-class letters. Here's the beautiful part: you can hear the class in the letter's name. Every high-class name carries a rising tone — khǎw, chǎw, thǎw, sǎw, hǎw. If you learn the names with their tones, you never have to memorise which class a letter belongs to. All high-class letters are aspirated (a puff of air) or fricatives (s, f, h)." },
    { "key": "low1",     "kind": "letters", "title": "Low-class consonants — group 1", "short": "Low class 1",
      "page": "read-low1.html",
      "blurb": "13 letters",
      "intro": "Low class is the biggest class, so Thai splits it in two. Group 1 is the paired low consonants — each sounds identical to a high-class partner (ค sounds like ข, ช like ฉ, ท like ถ, พ like ผ, ฟ like ฝ, ซ like ส, ฮ like ห). Same sound, different class — and that's the whole point: the class changes which tones the syllable can carry. Low-class names start on a plain mid tone: khaw, chaw, thaw." },
    { "key": "low2",     "kind": "letters", "title": "Low-class consonants — group 2", "short": "Low class 2",
      "page": "read-low2.html",
      "blurb": "10 letters",
      "intro": "Group 2 is the unpaired low consonants — the sonorants: nasals (ม, น, ณ, ง), liquids (ร, ล, ฬ) and glides (ย, ญ, ว). They have no high-class twin. Thai's workaround, which you'll meet in the tone rules, is to put a silent ห in front of them (หมู, หนู, แหวน) to make them behave as high class. Several of the name-words below already use that trick — the transliteration shows you the tone it produces." },
    { "key": "vlong",    "kind": "vowels",  "title": "Long vowels",  "short": "Long vowels",
      "page": "read-vowels-long.html",
      "blurb": "9 vowels",
      "intro": "Thai vowels attach to a consonant — above, below, before, after, or wrapped right around it. The ◌ in each symbol shows where the consonant sits. Note that some vowels are written BEFORE the consonant but spoken after it: เ◌, แ◌, โ◌. These 9 are the long vowels — held noticeably longer, roughly twice the length of their short partners. Length matters: it changes meaning, and (as you'll see in the tone rules) it can change the tone." },
    { "key": "vshort",   "kind": "vowels",  "title": "Short vowels", "short": "Short vowels",
      "page": "read-vowels-short.html",
      "blurb": "9 vowels",
      "intro": "Each long vowel has a short partner — same mouth shape, clipped off quickly, usually written by adding ะ. Two extra spelling habits to know: when a syllable has a final consonant, short a is written with ◌ั above the consonant instead of ◌ะ (กับ gàp — 'with'), and the little ◌็ shortens เ◌ and แ◌ (เด็ก dèk — 'child'). A short vowel with no final consonant makes a syllable 'dead' — which the tone rules care about a lot." },
    { "key": "vspecial", "kind": "vowels",  "title": "Special vowels", "short": "Special vowels",
      "page": "read-vowels-special.html",
      "blurb": "8 vowels",
      "intro": "The leftovers — and some of the most common syllables in Thai. Four of them secretly contain their own ending sound: ◌ำ ends in m, ใ◌ and ไ◌ end in y, เ◌า ends in w — so syllables built on them count as 'live' for the tone rules. ใ◌ and ไ◌ sound identical; only 20 words use ใ◌ (all others use ไ◌). The three gliding vowels (เ◌ีย, เ◌ือ, ◌ัว) slide from one vowel into another. ฤ is a rare consonant-vowel hybrid you'll mostly meet in ฤดู (season)." },
    { "key": "finals",   "kind": "finals",  "title": "Final consonants", "short": "Final consonants",
      "page": "read-finals.html",
      "blurb": "The 8 sounds a syllable can end with",
      "intro": "Thai syllables can only end in eight sounds. Whatever letter is written, at the end of a syllable its sound collapses to one of the eight — ส sounds like s at the start of a word but like t at the end. How a syllable ends decides whether it is live or dead — the heart of the tone rules later." },
    { "key": "sounds",   "kind": "sounds",  "title": "The sounds of Thai", "short": "Sounds of Thai",
      "page": "read-sounds.html",
      "blurb": "Aspiration, stops & sonorants",
      "intro": "You've now met every letter, and how syllables end. Before the tone rules, meet the sound families the letters fall into. A few minutes here sharpens your ear for the distinctions English doesn't make — and the tone rules lean on these families directly." },
    { "key": "tones",    "kind": "tones",   "title": "The tone rules", "short": "Tone rules",
      "page": "read-tones.html",
      "blurb": "How the spelling gives you the tone" },
    { "key": "clusters", "kind": "clusters", "title": "Consonant clusters", "short": "Clusters",
      "page": "read-clusters.html",
      "blurb": "Two consonants together — one syllable or two",
      "intro": "Some syllables start with two written consonants. Sometimes they blend into ONE syllable (กล in กลัว glua — a true cluster), and sometimes an unwritten short \"a\" slips between them, making TWO syllables (สนุก sà-nùk). Either way, the rule that matters is one you now know how to use: the FIRST letter of the pair is the one that runs the tone rules." },
    { "key": "quiz",     "kind": "quiz",    "title": "Reading quiz", "short": "Reading quiz",
      "page": "read-quiz.html",
      "blurb": "Words and short sentences to read and check by ear" },
    { "key": "results",  "kind": "results", "title": "Your results", "short": "Your results",
      "page": "read-results.html",
      "blurb": "Every test, every score" }
  ],

  "toneKey": [
    { "mark": "á", "name": "high",    "desc": "acute — low→high" },
    { "mark": "à", "name": "low",     "desc": "grave — high→low" },
    { "mark": "â", "name": "falling", "desc": "circumflex" },
    { "mark": "ǎ", "name": "rising",  "desc": "caron — the upside-down ^" },
    { "mark": "a", "name": "mid",     "desc": "no mark" }
  ],

  "toneDemo": [
    { "thai": "คา", "t": "khaa", "tone": "mid",     "en": "to be stuck", "audio": "tone5-mid" },
    { "thai": "ข่า", "t": "khàa", "tone": "low",     "en": "galangal (a herb / spice)", "audio": "tone5-low" },
    { "thai": "ข้า", "t": "khâa", "tone": "falling", "en": "servant",     "audio": "tone5-falling" },
    { "thai": "ค้า", "t": "kháa", "tone": "high",    "en": "to trade",    "audio": "tone5-high" },
    { "thai": "ขา", "t": "khǎa", "tone": "rising",  "en": "leg",         "audio": "tone5-rising" }
  ],

  "letters": [
    { "cls": "mid", "ch": "ก", "name": "gaw gài",      "en": "chicken",        "word": "ไก่",    "wt": "gài",      "audio": "gaw-gai",       "ttsName": "กอไก่",       "ttsWord": "ไก่" },
    { "cls": "mid", "ch": "จ", "name": "jaw jaan",     "en": "plate",          "word": "จาน",   "wt": "jaan",     "audio": "jaw-jaan",      "ttsName": "จอจาน",      "ttsWord": "จาน" },
    { "cls": "mid", "ch": "ฎ", "name": "daw chá-daa",  "en": "dancer's crown", "word": "ชฎา",   "wt": "chá-daa",  "audio": "daw-chadaa",    "ttsName": "ดอชะดา",     "ttsWord": "ชฎา" },
    { "cls": "mid", "ch": "ฏ", "name": "dtaw bpà-dtàk","en": "goad / spear",   "word": "ปฏัก",  "wt": "bpà-dtàk", "audio": "dtaw-bpadtak",  "ttsName": "ตอปะตัก",    "ttsWord": "ปฏัก" },
    { "cls": "mid", "ch": "ด", "name": "daw dèk",      "en": "child",          "word": "เด็ก",   "wt": "dèk",      "audio": "daw-dek",       "ttsName": "ดอเด็ก",      "ttsWord": "เด็ก" },
    { "cls": "mid", "ch": "ต", "name": "dtaw dtào",    "en": "turtle",         "word": "เต่า",   "wt": "dtào",     "audio": "dtaw-dtao",     "ttsName": "ตอเต่า",      "ttsWord": "เต่า" },
    { "cls": "mid", "ch": "บ", "name": "baw bai-máai", "en": "leaf",           "word": "ใบไม้", "wt": "bai-máai", "audio": "baw-baimaai",   "ttsName": "บอใบไม้",    "ttsWord": "ใบไม้" },
    { "cls": "mid", "ch": "ป", "name": "bpaw bplaa",   "en": "fish",           "word": "ปลา",   "wt": "bplaa",    "audio": "bpaw-bplaa",    "ttsName": "ปอปลา",      "ttsWord": "ปลา" },
    { "cls": "mid", "ch": "อ", "name": "aw àang",      "en": "basin",          "word": "อ่าง",   "wt": "àang",     "audio": "aw-aang",       "ttsName": "อออ่าง",      "ttsWord": "อ่าง" },

    { "cls": "high", "ch": "ข", "name": "khǎw khài",    "en": "egg",           "word": "ไข่",    "wt": "khài",     "audio": "khaw-khai",     "ttsName": "ขอไข่",       "ttsWord": "ไข่" },
    { "cls": "high", "ch": "ฃ", "name": "khǎw khùat",   "en": "bottle",        "word": "ขวด",   "wt": "khùat",    "audio": "khaw-khuat",    "ttsName": "ขอขวด",      "ttsWord": "ขวด", "obsolete": true },
    { "cls": "high", "ch": "ฉ", "name": "chǎw chìng",   "en": "small cymbals", "word": "ฉิ่ง",    "wt": "chìng",    "audio": "chaw-ching",    "ttsName": "ฉอฉิ่ง",       "ttsWord": "ฉิ่ง" },
    { "cls": "high", "ch": "ฐ", "name": "thǎw thǎan",   "en": "pedestal",      "word": "ฐาน",   "wt": "thǎan",    "audio": "thaw-thaan",    "ttsName": "ถอถาน",      "ttsWord": "ฐาน" },
    { "cls": "high", "ch": "ถ", "name": "thǎw thǔng",   "en": "bag / sack",    "word": "ถุง",    "wt": "thǔng",    "audio": "thaw-thung",    "ttsName": "ถอถุง",       "ttsWord": "ถุง" },
    { "cls": "high", "ch": "ผ", "name": "phǎw phûeng",  "en": "bee",           "word": "ผึ้ง",    "wt": "phûeng",   "audio": "phaw-phueng",   "ttsName": "ผอผึ้ง",       "ttsWord": "ผึ้ง" },
    { "cls": "high", "ch": "ฝ", "name": "fǎw fǎa",      "en": "lid",           "word": "ฝา",    "wt": "fǎa",      "audio": "faw-faa",       "ttsName": "ฝอฝา",       "ttsWord": "ฝา" },
    { "cls": "high", "ch": "ศ", "name": "sǎw sǎa-laa",  "en": "pavilion",      "word": "ศาลา",  "wt": "sǎa-laa",  "audio": "saw-saalaa",    "ttsName": "สอสาลา",     "ttsWord": "ศาลา" },
    { "cls": "high", "ch": "ษ", "name": "sǎw ruue-sǐi", "en": "hermit",        "word": "ฤๅษี",   "wt": "ruue-sǐi", "audio": "saw-ruuesii",   "ttsName": "สอรือสี",     "ttsWord": "ฤๅษี" },
    { "cls": "high", "ch": "ส", "name": "sǎw sǔea",     "en": "tiger",         "word": "เสือ",   "wt": "sǔea",     "audio": "saw-suea",      "ttsName": "สอเสือ",      "ttsWord": "เสือ" },
    { "cls": "high", "ch": "ห", "name": "hǎw hìip",     "en": "chest / box",   "word": "หีบ",    "wt": "hìip",     "audio": "haw-hiip",      "ttsName": "หอหีบ",       "ttsWord": "หีบ" },

    { "cls": "low1", "ch": "ค", "name": "khaw khwaai",   "en": "buffalo",       "word": "ควาย",  "wt": "khwaai",    "audio": "khaw-khwaai",   "ttsName": "คอควาย",     "ttsWord": "ควาย" },
    { "cls": "low1", "ch": "ฅ", "name": "khaw khon",     "en": "person",        "word": "คน",    "wt": "khon",      "audio": "khaw-khon",     "ttsName": "คอคน",       "ttsWord": "คน", "obsolete": true },
    { "cls": "low1", "ch": "ฆ", "name": "khaw rá-khang", "en": "bell",          "word": "ระฆัง",  "wt": "rá-khang",  "audio": "khaw-rakhang",  "ttsName": "คอระคัง",     "ttsWord": "ระฆัง" },
    { "cls": "low1", "ch": "ช", "name": "chaw cháang",   "en": "elephant",      "word": "ช้าง",   "wt": "cháang",    "audio": "chaw-chaang",   "ttsName": "ชอช้าง",      "ttsWord": "ช้าง" },
    { "cls": "low1", "ch": "ซ", "name": "saw sôo",       "en": "chain",         "word": "โซ่",    "wt": "sôo",       "audio": "saw-soo",       "ttsName": "ซอโซ่",       "ttsWord": "โซ่" },
    { "cls": "low1", "ch": "ฌ", "name": "chaw chuhr",     "en": "tree (archaic)","word": "เฌอ",   "wt": "chuhr",      "audio": "chaw-choe",     "ttsName": "ชอเชอ",      "ttsWord": "เฌอ" },
    { "cls": "low1", "ch": "ฑ", "name": "thaw mon-thoo", "en": "Montho (Ramakien queen)", "word": "มณโฑ", "wt": "mon-thoo", "audio": "thaw-monthoo", "ttsName": "ทอมนโท", "ttsWord": "มณโฑ" },
    { "cls": "low1", "ch": "ฒ", "name": "thaw phûu-thâo","en": "elder",         "word": "ผู้เฒ่า",  "wt": "phûu-thâo", "audio": "thaw-phuuthao", "ttsName": "ทอผู้เท่า",     "ttsWord": "ผู้เฒ่า" },
    { "cls": "low1", "ch": "ท", "name": "thaw thá-hǎan", "en": "soldier",       "word": "ทหาร",  "wt": "thá-hǎan",  "audio": "thaw-thahaan",  "ttsName": "ทอทะหาน",   "ttsWord": "ทหาร" },
    { "cls": "low1", "ch": "ธ", "name": "thaw thong",    "en": "flag",          "word": "ธง",    "wt": "thong",     "audio": "thaw-thong",    "ttsName": "ทอทง",       "ttsWord": "ธง" },
    { "cls": "low1", "ch": "พ", "name": "phaw phaan",    "en": "offering tray", "word": "พาน",   "wt": "phaan",     "audio": "phaw-phaan",    "ttsName": "พอพาน",      "ttsWord": "พาน" },
    { "cls": "low1", "ch": "ฟ", "name": "faw fan",       "en": "tooth",         "word": "ฟัน",    "wt": "fan",       "audio": "faw-fan",       "ttsName": "ฟอฟัน",       "ttsWord": "ฟัน" },
    { "cls": "low1", "ch": "ภ", "name": "phaw sǎm-phao", "en": "sailing junk",  "word": "สำเภา", "wt": "sǎm-phao",  "audio": "phaw-samphao",  "ttsName": "พอสำเพา",    "ttsWord": "สำเภา" },
    { "cls": "low1", "ch": "ฮ", "name": "haw nók-hûuk",  "en": "owl",           "word": "นกฮูก", "wt": "nók-hûuk",  "audio": "haw-nokhuuk",   "ttsName": "ฮอนกฮูก",    "ttsWord": "นกฮูก" },

    { "cls": "low2", "ch": "ง", "name": "ngaw nguu",   "en": "snake",        "word": "งู",     "wt": "nguu",    "audio": "ngaw-nguu",   "ttsName": "งองู",       "ttsWord": "งู" },
    { "cls": "low2", "ch": "ญ", "name": "yaw yǐng",    "en": "woman",        "word": "หญิง",  "wt": "yǐng",    "audio": "yaw-ying",    "ttsName": "ยอหยิง",    "ttsWord": "หญิง" },
    { "cls": "low2", "ch": "ณ", "name": "naw neen",    "en": "novice monk",  "word": "เณร",   "wt": "neen",    "audio": "naw-neen",    "ttsName": "นอเนน",     "ttsWord": "เณร" },
    { "cls": "low2", "ch": "น", "name": "naw nǔu",     "en": "mouse",        "word": "หนู",    "wt": "nǔu",     "audio": "naw-nuu",     "ttsName": "นอหนู",      "ttsWord": "หนู" },
    { "cls": "low2", "ch": "ม", "name": "maw máa",     "en": "horse",        "word": "ม้า",    "wt": "máa",     "audio": "maw-maa",     "ttsName": "มอม้า",      "ttsWord": "ม้า" },
    { "cls": "low2", "ch": "ย", "name": "yaw yák",     "en": "giant / ogre", "word": "ยักษ์",  "wt": "yák",     "audio": "yaw-yak",     "ttsName": "ยอยัก",      "ttsWord": "ยักษ์" },
    { "cls": "low2", "ch": "ร", "name": "raw ruea",    "en": "boat",         "word": "เรือ",   "wt": "ruea",    "audio": "raw-ruea",    "ttsName": "รอเรือ",     "ttsWord": "เรือ" },
    { "cls": "low2", "ch": "ล", "name": "law ling",    "en": "monkey",       "word": "ลิง",    "wt": "ling",    "audio": "law-ling",    "ttsName": "ลอลิง",      "ttsWord": "ลิง" },
    { "cls": "low2", "ch": "ว", "name": "waw wǎen",    "en": "ring",         "word": "แหวน",  "wt": "wǎen",    "audio": "waw-waen",    "ttsName": "วอแหวน",    "ttsWord": "แหวน" },
    { "cls": "low2", "ch": "ฬ", "name": "law jù-laa",  "en": "kite",         "word": "จุฬา",   "wt": "jù-laa",  "audio": "law-julaa",   "ttsName": "ลอจุลา",     "ttsWord": "จุฬา" }
  ],

  "vowels": [
    { "cls": "vlong", "ch": "◌า",  "name": "sara aa",  "sound": "aa — as in \"father\"",              "ex": "มา",  "ext": "maa",  "en": "to come",    "audio": "sara-aa",  "ttsName": "สระอา",  "ttsEx": "มา" },
    { "cls": "vlong", "ch": "◌ี",   "name": "sara ii",  "sound": "ii — as in \"see\"",                 "ex": "ดี",   "ext": "dii",  "en": "good",       "audio": "sara-ii",  "ttsName": "สระอี",   "ttsEx": "ดี" },
    { "cls": "vlong", "ch": "◌ือ",  "name": "sara uue", "sound": "uue — \"oo\" with unrounded lips",   "ex": "มือ",  "ext": "muue", "en": "hand",       "audio": "sara-uue", "ttsName": "สระอือ",  "ttsEx": "มือ" },
    { "cls": "vlong", "ch": "◌ู",   "name": "sara uu",  "sound": "uu — as in \"moon\"",                "ex": "งู",   "ext": "nguu", "en": "snake",      "audio": "sara-uu",  "ttsName": "สระอู",   "ttsEx": "งู" },
    { "cls": "vlong", "ch": "เ◌",  "name": "sara ee",  "sound": "ee — as in \"pay\" (no y-glide)",    "ex": "เพลง",  "ext": "phleeng", "en": "song",    "audio": "sara-ee",  "ttsName": "สระเอ",  "ttsEx": "เพลง" },
    { "cls": "vlong", "ch": "แ◌",  "name": "sara aae", "sound": "aae — as in \"fair\"",              "ex": "แม่",  "ext": "mâae", "en": "mother",     "audio": "sara-aae", "ttsName": "สระแอ",  "ttsEx": "แม่" },
    { "cls": "vlong", "ch": "โ◌",  "name": "sara oo",  "sound": "oo — as in \"go\" (no w-glide)",     "ex": "โต",  "ext": "dtoo", "en": "big",        "audio": "sara-oo",  "ttsName": "สระโอ",  "ttsEx": "โต" },
    { "cls": "vlong", "ch": "◌อ",  "name": "sara aw",  "sound": "aw — as in \"saw\"",                 "ex": "ขอ",  "ext": "khǎw", "en": "to ask for", "audio": "sara-aw",  "ttsName": "สระออ",  "ttsEx": "ขอ" },
    { "cls": "vlong", "ch": "เ◌อ", "name": "sara uhr",  "sound": "uhr — as in \"eugh\" (the sound of disgust)", "ex": "เธอ", "ext": "thuhr", "en": "she / you",  "audio": "sara-oe",  "ttsName": "สระเออ", "ttsEx": "เธอ" },

    { "cls": "vshort", "ch": "◌ะ",   "name": "sara a",        "sound": "a — short, as in \"apple\"",         "ex": "จะ",   "ext": "jà",   "en": "will",      "audio": "sara-a",       "ttsName": "สระอะ",   "ttsEx": "จะ" },
    { "cls": "vshort", "ch": "◌ิ",    "name": "sara i",        "sound": "i — short, as in \"bit\"",           "ex": "กิน",  "ext": "gin",  "en": "to eat",    "audio": "sara-i",       "ttsName": "สระอิ",    "ttsEx": "กิน" },
    { "cls": "vshort", "ch": "◌ึ",    "name": "sara ue",       "sound": "ue — short unrounded \"oo\"",        "ex": "ถึง",   "ext": "thǔeng","en": "to reach", "audio": "sara-ue",      "ttsName": "สระอึ",    "ttsEx": "ถึง" },
    { "cls": "vshort", "ch": "◌ุ",    "name": "sara u",        "sound": "u — as the oo in \"group\"",         "ex": "คุณ",  "ext": "khun", "en": "you",       "audio": "sara-u",       "ttsName": "สระอุ",    "ttsEx": "คุณ" },
    { "cls": "vshort", "ch": "เ◌ะ",  "name": "sara e",        "sound": "e — short, as in \"let\"",           "ex": "เตะ",  "ext": "dtè",  "en": "to kick",   "audio": "sara-e",       "ttsName": "สระเอะ",  "ttsEx": "เตะ" },
    { "cls": "vshort", "ch": "แ◌ะ",  "name": "sara ae",       "sound": "ae — as in \"eh\" (indifference)",   "ex": "แกะ",  "ext": "gàe",  "en": "sheep",     "audio": "sara-ae",      "ttsName": "สระแอะ",  "ttsEx": "แกะ" },
    { "cls": "vshort", "ch": "โ◌ะ",  "name": "sara o",        "sound": "o — short, clipped \"go\"",          "ex": "โต๊ะ",  "ext": "dtó",  "en": "table",     "audio": "sara-o",       "ttsName": "สระโอะ",  "ttsEx": "โต๊ะ" },
    { "cls": "vshort", "ch": "เ◌าะ", "name": "sara aw (short)","sound": "aw — short, as in British \"hot\"", "ex": "เกาะ", "ext": "gàw",  "en": "island",    "audio": "sara-aw-short","ttsName": "สระเอาะ", "ttsEx": "เกาะ" },
    { "cls": "vshort", "ch": "เ◌อะ", "name": "sara uhr (short)","sound": "uh — short, as in \"the\"",         "ex": "เยอะ", "ext": "yúh",  "en": "a lot",     "audio": "sara-oe-short","ttsName": "สระเออะ", "ttsEx": "เยอะ" },

    { "cls": "vspecial", "ch": "◌ำ",  "name": "sara am",              "sound": "am — as in \"scramble\" (ends in m → live)", "ex": "ทำ",   "ext": "tham", "en": "to do",    "audio": "sara-am",         "ttsName": "สระอำ",           "ttsEx": "ทำ" },
    { "cls": "vspecial", "ch": "ใ◌",  "name": "sara ai (mái múan)",   "sound": "ai — as in \"eye\" (only 20 words use it)","ex": "ใจ",   "ext": "jai",  "en": "heart",    "audio": "sara-ai-maimuan", "ttsName": "สระใอ ไม้ม้วน",     "ttsEx": "ใจ" },
    { "cls": "vspecial", "ch": "ไ◌",  "name": "sara ai (mái má-laai)","sound": "ai — as in \"eye\" (the usual spelling)",  "ex": "ไป",   "ext": "bpai", "en": "to go",    "audio": "sara-ai-maimalaai","ttsName": "สระไอ ไม้มะลาย",  "ttsEx": "ไป" },
    { "cls": "vspecial", "ch": "เ◌า", "name": "sara ao",              "sound": "ao — as in \"cow\" (ends in w → live)",    "ex": "เอา",  "ext": "ao",   "en": "to take",  "audio": "sara-ao",         "ttsName": "สระเอา",          "ttsEx": "เอา" },
    { "cls": "vspecial", "ch": "◌ัว",  "name": "sara ua",              "sound": "ua — glides \"oo → ah\"",                  "ex": "กลัว",  "ext": "glua", "en": "afraid",   "audio": "sara-ua",         "ttsName": "สระอัว",           "ttsEx": "กลัว" },
    { "cls": "vspecial", "ch": "เ◌ีย", "name": "sara ia",              "sound": "ia — glides \"ee → ah\"",                  "ex": "เรียน", "ext": "rian", "en": "to study", "audio": "sara-ia",         "ttsName": "สระเอีย",          "ttsEx": "เรียน" },
    { "cls": "vspecial", "ch": "เ◌ือ", "name": "sara uea",             "sound": "uea — glides \"uue → ah\"",                "ex": "เรือ",  "ext": "ruea", "en": "boat",     "audio": "sara-uea",        "ttsName": "สระเอือ",          "ttsEx": "เรือ" },
    { "cls": "vspecial", "ch": "ฤ",   "name": "rue",                  "sound": "rúe / rí — a consonant-vowel hybrid",      "ex": "ฤดู",   "ext": "rúe-duu","en": "season", "audio": "rue",             "ttsName": "รึ",               "ttsEx": "ฤดู" }
  ],

  "soundsPage": {
    "sections": [
      { "heading": "Three kinds of consonant sound",
        "body": "Every Thai consonant makes its sound in one of three ways, and which one it is decides everything else on this page. A stop blocks the air completely, then lets it go in a burst — g, k, b, p, d, t, j, ch. A fricative never blocks it: the air is squeezed through a narrow gap and hisses on — s, f, h. A sonorant lets the voice ring out freely — m, n, ng, y, r, l, w. Say the three words below and feel what your mouth does at the very start of each: a block, a hiss, a ring.",
        "chips": [
          { "thai": "ไก่",  "t": "gài",  "en": "chicken", "tag": "stop — a block",      "audio": "gaw-gai-word" },
          { "thai": "เสือ", "t": "sǔea", "en": "tiger",   "tag": "fricative — a hiss",  "audio": "saw-suea-word" },
          { "thai": "งู",   "t": "nguu", "en": "snake",   "tag": "sonorant — a ring",   "audio": "ngaw-nguu-word" }
        ] },
      { "heading": "Aspiration — the question only stops answer",
        "body": "Hold your palm in front of your mouth and say English \"pie\" — you feel a puff of air. That puff is aspiration. In English it never changes a word's meaning; in Thai it does. ไก่ and ไข่ both OPEN with a stop, made in the same place in the mouth, and the puff is the only thing standing between chicken and egg. So ก and ข are the same kind of sound asked the same question: puff, or no puff? That question is only ever asked of stops — the other two kinds have no burst to put a puff on.",
        "chips": [
          { "thai": "ไก่", "t": "gài", "en": "chicken", "tag": "unaspirated", "audio": "gaw-gai-word" },
          { "thai": "ไข่", "t": "khài", "en": "egg",     "tag": "aspirated",   "audio": "khaw-khai-word" }
        ] },
      { "heading": "The three-way split",
        "body": "All six sounds below are stops — three made with the lips, three with the tip of the tongue. Where English has b and p, Thai has three separate sounds. บ is voiced — your voicebox vibrates from the start (put your fingers on your throat and say b to feel it). ป is unaspirated — no puff of air, and no vibration until the vowel starts. พ and ผ are aspirated — said with the puff. ป is the one to practise, because English never uses it on its own. The same three points apply respectively to the following letters: ด, ต, ท.",
        "chips": [
          { "thai": "บ้า", "t": "bâa",  "en": "crazy",   "tag": "b",  "audio": "sd-baa" },
          { "thai": "ป้า", "t": "bpâa", "en": "aunt",    "tag": "bp", "audio": "sd-bpaa" },
          { "thai": "ผ้า", "t": "phâa", "en": "cloth",   "tag": "ph", "audio": "sd-phaa" },
          { "thai": "ดี",  "t": "dii",  "en": "good",    "tag": "d",  "audio": "sara-ii-ex" },
          { "thai": "ตี",  "t": "dtii", "en": "to hit",  "tag": "dt", "audio": "sd-dtii" },
          { "thai": "ที",  "t": "thii", "en": "turn / occasion", "tag": "th", "audio": "sd-thii" }
        ] },
      { "heading": "The same stops at the END of a syllable",
        "body": "Everything so far has been about stops at the START of a syllable. The very same letters can end one too — and there they behave differently. At the end of a Thai syllable a stop is never released: the mouth closes on the sound and simply stays closed. No burst, so no puff, so the aspirated/unaspirated question never arises at the end of a word. That is why มาก can sound like \"maa\" with a sudden cut. Listen for the closure:",
        "chips": [
          { "thai": "กับ", "t": "gàp",  "en": "with",    "tag": "-p", "audio": "rule-gap" },
          { "thai": "พูด", "t": "phûut", "en": "to speak","tag": "-t", "audio": "quiz-phuut" },
          { "thai": "มาก", "t": "mâak", "en": "very",    "tag": "-k", "audio": "rule-maak" }
        ] },
      { "heading": "Fricatives",
        "body": "Here the air never fully stops — it is squeezed through a narrow gap and hisses continuously: s, f, h. Because there is no burst to release, a fricative is neither aspirated nor unaspirated; the question simply does not arise. Nothing here is new to an English speaker:",
        "chips": [
          { "thai": "เสือ", "t": "sǔea", "en": "tiger", "tag": "s", "audio": "saw-suea-word" },
          { "thai": "ฟัน",  "t": "fan",  "en": "tooth", "tag": "f", "audio": "faw-fan-word" },
          { "thai": "ห้า",  "t": "hâa",  "en": "five",  "tag": "h", "audio": "quiz-haa" }
        ] },
      { "heading": "Sonorants",
        "body": "The sounds that can ring on: m, n, ng, y, r, l, w — the whole of low class group 2. Like fricatives they have no burst, so the aspiration question does not apply to them either. Only one is genuinely new to English speakers: ng at the START of a word. English has it only at the end (si-ng); Thai is happy to open with it:",
        "chips": [
          { "thai": "งู",   "t": "nguu", "en": "snake",    "tag": "ng-", "audio": "ngaw-nguu-word" },
          { "thai": "สาม", "t": "sǎam", "en": "three",    "tag": "-m",  "audio": "quiz-saam" },
          { "thai": "เรียน","t": "rian", "en": "to study", "tag": "-n",  "audio": "sara-ia-ex" }
        ] }
    ],
    "rule": {
      "heading": "Which letters are which — the rule",
      "body": "So every consonant carries two independent labels: the KIND of sound it makes — stop, fricative or sonorant — and the CLASS it belongs to. Put the two together and the puff is completely settled. Every MID-class stop is unaspirated: ก จ ฎ ฏ ด ต บ ป all have that hard, flat sound, and บ and ด go one step further and are voiced, like English b and d. Every HIGH- or LOW-class stop is aspirated. Fricatives and sonorants sit outside the question entirely — no burst to aspirate. (อ stands apart as the silent vowel-carrier.) These four groups are the four answers in the \"Which family?\" test below:",
      "families": [
        { "label": "Unaspirated stops", "letters": "ก จ ฎ ฏ ด ต บ ป", "note": "all mid class · บ ด voiced" },
        { "label": "Aspirated stops",   "letters": "ข ฉ ฐ ถ ผ · ค ฆ ช ฌ ฑ ฒ ท ธ พ ภ", "note": "high class · low class" },
        { "label": "Fricatives",        "letters": "ศ ษ ส ห ฝ · ซ ฟ ฮ", "note": "high class · low class" },
        { "label": "Sonorants",         "letters": "ง ญ ณ น ม ย ร ล ว ฬ", "note": "low class group 2" }
      ]
    },
    "aspTest": [
      { "thai": "ไก่",  "t": "gài",   "en": "chicken",  "asp": false, "audio": "gaw-gai-word" },
      { "thai": "ไข่",  "t": "khài",  "en": "egg",      "asp": true,  "audio": "khaw-khai-word" },
      { "thai": "ตี",   "t": "dtii",  "en": "to hit",   "asp": false, "audio": "sd-dtii" },
      { "thai": "ที",   "t": "thii",  "en": "turn",     "asp": true,  "audio": "sd-thii" },
      { "thai": "บ้า",  "t": "bâa",   "en": "crazy",    "asp": false, "audio": "sd-baa" },
      { "thai": "ป้า",  "t": "bpâa",  "en": "aunt",     "asp": false, "audio": "sd-bpaa" },
      { "thai": "ผ้า",  "t": "phâa",  "en": "cloth",    "asp": true,  "audio": "sd-phaa" },
      { "thai": "เต่า",  "t": "dtào",  "en": "turtle",   "asp": false, "audio": "dtaw-dtao-word" },
      { "thai": "ปลา",  "t": "bplaa", "en": "fish",     "asp": false, "audio": "bpaw-bplaa-word" },
      { "thai": "ควาย", "t": "khwaai","en": "buffalo",  "asp": true,  "audio": "khaw-khwaai-word" },
      { "thai": "จาน",  "t": "jaan",  "en": "plate",    "asp": false, "audio": "jaw-jaan-word" },
      { "thai": "ช้าง",  "t": "cháang","en": "elephant", "asp": true,  "audio": "chaw-chaang-word" },
      { "thai": "ถูก",   "t": "thùuk", "en": "cheap",    "asp": true,  "audio": "quiz-thuuk" },
      { "thai": "กิน",   "t": "gin",   "en": "to eat",   "asp": false, "audio": "sara-i-ex" },
      { "thai": "เผ็ด",  "t": "phèt",  "en": "spicy",    "asp": true,  "audio": "quiz-phet" },
      { "thai": "ถุง",   "t": "thǔng", "en": "bag",      "asp": true,  "audio": "thaw-thung-word" }
    ]
  },

  "finalsPage": {
    "translitNote": "In our transliteration a final y shows as -i (khwaai) and a final w as -o (khâao) — that's just how the glide reads on paper; the mouth is doing y and w.",
    "groups": [
      { "sound": "-k",  "type": "stop · dead",     "letters": "ก ข ค ฆ",                     "ex": { "thai": "มาก", "t": "mâak", "en": "very",      "audio": "rule-maak" } },
      { "sound": "-t",  "type": "stop · dead",     "letters": "จ ช ซ ด ต ถ ท ธ ฎ ฏ ฐ ฑ ฒ ศ ษ ส", "ex": { "thai": "รถ",  "t": "rót",  "en": "car",       "audio": "fn-rot" } },
      { "sound": "-p",  "type": "stop · dead",     "letters": "บ ป พ ฟ ภ",                   "ex": { "thai": "หีบ",  "t": "hìip", "en": "chest",     "audio": "haw-hiip-word" } },
      { "sound": "-ng", "type": "sonorant · live", "letters": "ง",                           "ex": { "thai": "สอง", "t": "sǎwng","en": "two",       "audio": "quiz-sawng" } },
      { "sound": "-n",  "type": "sonorant · live", "letters": "น ณ ญ ร ล ฬ",                 "ex": { "thai": "กิน",  "t": "gin",  "en": "to eat",    "audio": "sara-i-ex" } },
      { "sound": "-m",  "type": "sonorant · live", "letters": "ม",                           "ex": { "thai": "สาม", "t": "sǎam", "en": "three",     "audio": "quiz-saam" } },
      { "sound": "-y",  "type": "sonorant · live", "letters": "ย",                           "ex": { "thai": "สวย", "t": "sǔai", "en": "beautiful", "audio": "fn-suay" } },
      { "sound": "-w",  "type": "sonorant · live", "letters": "ว",                           "ex": { "thai": "ข้าว", "t": "khâao","en": "rice",      "audio": "quiz-khaao" } }
    ],
    "neverFinal": "ฉ ผ ฝ ห ฮ อ",
    "hearTest": [
      { "thai": "มาก",  "t": "mâak",  "en": "very",      "final": "-k",  "audio": "rule-maak" },
      { "thai": "ยาก",  "t": "yâak",  "en": "difficult", "final": "-k",  "audio": "quiz-yaak" },
      { "thai": "พูด",  "t": "phûut", "en": "to speak",  "final": "-t",  "audio": "quiz-phuut" },
      { "thai": "รถ",   "t": "rót",   "en": "car",       "final": "-t",  "audio": "fn-rot" },
      { "thai": "ขาด",  "t": "khàat", "en": "torn",      "final": "-t",  "audio": "rule-khaat" },
      { "thai": "กับ",  "t": "gàp",   "en": "with",      "final": "-p",  "audio": "rule-gap" },
      { "thai": "หีบ",   "t": "hìip",  "en": "chest",     "final": "-p",  "audio": "haw-hiip-word" },
      { "thai": "สอง",  "t": "sǎwng", "en": "two",       "final": "-ng", "audio": "quiz-sawng" },
      { "thai": "หนึ่ง",  "t": "nùeng", "en": "one",       "final": "-ng", "audio": "quiz-nueng" },
      { "thai": "กิน",   "t": "gin",   "en": "to eat",    "final": "-n",  "audio": "sara-i-ex" },
      { "thai": "เย็น",  "t": "yen",   "en": "cool",      "final": "-n",  "audio": "quiz-yen" },
      { "thai": "ฟัน",   "t": "fan",   "en": "tooth",     "final": "-n",  "audio": "faw-fan-word" },
      { "thai": "สาม",  "t": "sǎam",  "en": "three",     "final": "-m",  "audio": "quiz-saam" },
      { "thai": "ทำ",   "t": "tham",  "en": "to do",     "final": "-m",  "audio": "sara-am-ex" },
      { "thai": "สวย",  "t": "sǔai",  "en": "beautiful", "final": "-y",  "audio": "fn-suay" },
      { "thai": "ข้าว",  "t": "khâao", "en": "rice",      "final": "-w",  "audio": "quiz-khaao" }
    ]
  },

  "clustersPage": {
    "trueIntro": "True clusters blend both consonants into one syllable — the second letter is always ร, ล or ว. The first letter's class sets the tone: กรอบ gràwp is low because ก is mid class and the syllable is dead; แผล phlǎae is rising because ผ is high class; พร้อม phráwm is high because พ is low class with mái thoo. These are the common ones:",
    "true": [
      { "cl": "กร", "thai": "กรอบ",   "t": "gràwp",   "en": "crispy",      "audio": "cl-grawp",   "wrong": ["gà-ràwp", "gàwp", "khràwp"] },
      { "cl": "กล", "thai": "กลัว",   "t": "glua",    "en": "afraid",      "audio": "sara-ua-ex",    "wrong": ["gà-lua", "gua", "khlua"] },
      { "cl": "กว", "thai": "กว้าง",  "t": "gwâang",  "en": "wide",        "audio": "cl-gwaang",  "wrong": ["gà-wâang", "wâang", "khwâang"] },
      { "cl": "ขว", "thai": "ขวา",    "t": "khwǎa",   "en": "right (side)","audio": "cl-khwaa",   "wrong": ["khà-wǎa", "wǎa", "gwǎa"] },
      { "cl": "คร", "thai": "ใคร",    "t": "khrai",   "en": "who",         "audio": "cl-khrai",   "wrong": ["khà-rai", "kai", "grai"] },
      { "cl": "คล", "thai": "คลอง",  "t": "khlawng", "en": "canal",       "audio": "cl-khlawng", "wrong": ["khà-lawng", "khawng", "glawng"] },
      { "cl": "คว", "thai": "ควาย",  "t": "khwaai",  "en": "buffalo",     "audio": "khaw-khwaai-word", "wrong": ["khà-waai", "khaai", "gwaai"] },
      { "cl": "ตร", "thai": "ตรง",    "t": "dtrong",  "en": "straight",    "audio": "cl-dtrong",  "wrong": ["dtà-rong", "dtong", "throng"] },
      { "cl": "ปร", "thai": "เปรี้ยว", "t": "bprîao",  "en": "sour",        "audio": "cl-bpriao",  "wrong": ["bpà-rîao", "bpîao", "phrîao"] },
      { "cl": "ปล", "thai": "ปลา",    "t": "bplaa",   "en": "fish",        "audio": "bpaw-bplaa-word", "wrong": ["bpà-laa", "bpaa", "phlaa"] },
      { "cl": "ผล", "thai": "แผล",    "t": "phlǎae",  "en": "wound",       "audio": "cl-phlae",   "wrong": ["phà-lǎae", "phǎae", "bplǎae"] },
      { "cl": "พร", "thai": "พร้อม",  "t": "phráwm",  "en": "ready",       "audio": "cl-phrawm",  "wrong": ["phà-ráwm", "pháwm", "bpráwm"] },
      { "cl": "พล", "thai": "เพลง",   "t": "phleeng", "en": "song",        "audio": "sara-ee-ex", "wrong": ["phà-leeng", "pheeng", "bpleeng"] }
    ],
    "falseIntro": "A few written clusters are fakes — the ร is silent, or ทร reads as s. Only a handful of words do this; meet the two you'll see most:",
    "false": [
      { "thai": "จริง", "t": "jing",  "en": "true / really",    "audio": "cl-jing", "note": "ร silent", "wrong": ["jà-ring", "jring", "rìng"] },
      { "thai": "ทราบ", "t": "sâap", "en": "to know (formal)", "audio": "cl-saap", "note": "ทร → s",  "wrong": ["thà-râap", "thrâap", "râap"] }
    ],
    "leadingIntro": "When the pair DOESN'T blend, an unwritten short \"a\" appears after the first letter, making two syllables. The first letter still runs the show: if the second letter is a group-2 sonorant, the first letter's class sets the tone of the SECOND syllable. That's why สนุก is sà-nùk (low tone from high-class ส) and ขนม is khà-nǒm (rising from high-class ข) — the silent-ห trick from the finals step is this same idea in disguise:",
    "leading": [
      { "thai": "สนุก",  "t": "sà-nùk",   "en": "fun",             "audio": "cl-sanuk",   "wrong": ["snùk", "sà-núk", "sà-nuk"] },
      { "thai": "ตลาด", "t": "dtà-làat", "en": "market",          "audio": "cl-dtalaat", "wrong": ["dtlàat", "dtà-láat", "dtà-laat"] },
      { "thai": "ขนม",  "t": "khà-nǒm",  "en": "snack / dessert", "audio": "cl-khanom",  "wrong": ["khnom", "khà-nom", "khà-nòm"] }
    ]
  },

  "toneMarks": [
    { "mark": "◌่", "name": "mái èek",        "t": "" },
    { "mark": "◌้", "name": "mái thoo",       "t": "" },
    { "mark": "◌๊", "name": "mái dtrii",      "t": "mid-class words only" },
    { "mark": "◌๋", "name": "mái jàt-dtà-waa","t": "mid-class words only" }
  ],

  "toneRules": {
    "columns": ["No mark — live", "No mark — dead, short", "No mark — dead, long", "+ ◌่", "+ ◌้", "+ ◌๊", "+ ◌๋"],
    "rows": [
      { "cls": "Mid class", "cells": [
        { "tone": "mid",     "thai": "กา",  "t": "gaa",  "en": "crow",    "audio": "rule-gaa" },
        { "tone": "low",     "thai": "กับ", "t": "gàp",  "en": "with",    "audio": "rule-gap" },
        { "tone": "low",     "thai": "จาก", "t": "jàak", "en": "from",    "audio": "rule-jaak" },
        { "tone": "low",     "thai": "เก่า", "t": "gào",  "en": "old",     "audio": "rule-gao" },
        { "tone": "falling", "thai": "ได้",  "t": "dâai", "en": "can",     "audio": "rule-daai" },
        { "tone": "high",    "thai": "โต๊ะ", "t": "dtó",  "en": "table",   "audio": "sara-o-ex" },
        { "tone": "rising",  "thai": "จ๋า",  "t": "jǎa",  "en": "sweetie!","audio": "rule-jaa" }
      ]},
      { "cls": "High class", "cells": [
        { "tone": "rising",  "thai": "ขา",  "t": "khǎa",  "en": "leg",   "audio": "tone5-rising" },
        { "tone": "low",     "thai": "ขับ", "t": "khàp",  "en": "to drive", "audio": "rule-khap" },
        { "tone": "low",     "thai": "ขาด", "t": "khàat", "en": "torn",  "audio": "rule-khaat" },
        { "tone": "low",     "thai": "ข่าว", "t": "khàao", "en": "news",  "audio": "rule-khaao-low" },
        { "tone": "falling", "thai": "ข้าว", "t": "khâao", "en": "rice",  "audio": "quiz-khaao" },
        null,
        null
      ]},
      { "cls": "Low class", "cells": [
        { "tone": "mid",     "thai": "มา",  "t": "maa",  "en": "to come", "audio": "sara-aa-ex" },
        { "tone": "high",    "thai": "รัก",  "t": "rák",  "en": "to love", "audio": "quiz-rak" },
        { "tone": "falling", "thai": "มาก", "t": "mâak", "en": "very",    "audio": "rule-maak" },
        { "tone": "falling", "thai": "ไม่",  "t": "mâi",  "en": "not",     "audio": "rule-mai" },
        { "tone": "high",    "thai": "ม้า",  "t": "máa",  "en": "horse",   "audio": "maw-maa-word" },
        null,
        null
      ]}
    ]
  },

  "quiz": [
    { "thai": "มา",     "t": "maa",       "en": "to come",   "audio": "sara-aa-ex" },
    { "thai": "ไก่",     "t": "gài",       "en": "chicken",   "audio": "gaw-gai-word" },
    { "thai": "น้ำ",     "t": "náam",      "en": "water",     "audio": "quiz-naam" },
    { "thai": "ข้าว",    "t": "khâao",     "en": "rice",      "audio": "quiz-khaao" },
    { "thai": "หมู",     "t": "mǔu",       "en": "pig",       "audio": "quiz-muu",  "note": "silent ห makes ม behave as high class" },
    { "thai": "ไป",     "t": "bpai",      "en": "to go",     "audio": "sara-ai-maimalaai-ex" },
    { "thai": "พูด",     "t": "phûut",     "en": "to speak",  "audio": "quiz-phuut" },
    { "thai": "รัก",      "t": "rák",       "en": "to love",   "audio": "quiz-rak" },
    { "thai": "เก้า",     "t": "gâo",       "en": "nine",      "audio": "quiz-gao" },
    { "thai": "ดี",      "t": "dii",       "en": "good",      "audio": "sara-ii-ex" },
    { "thai": "ร้อน",    "t": "ráwn",      "en": "hot",       "audio": "quiz-rawn" },
    { "thai": "เย็น",    "t": "yen",       "en": "cool",      "audio": "quiz-yen" },
    { "thai": "หนึ่ง",    "t": "nùeng",     "en": "one",       "audio": "quiz-nueng", "note": "silent ห + tone mark" },
    { "thai": "สอง",    "t": "sǎwng",     "en": "two",       "audio": "quiz-sawng" },
    { "thai": "สาม",    "t": "sǎam",      "en": "three",     "audio": "quiz-saam" },
    { "thai": "สี่",      "t": "sìi",       "en": "four",      "audio": "quiz-sii" },
    { "thai": "ห้า",     "t": "hâa",       "en": "five",      "audio": "quiz-haa" },
    { "thai": "กิน",     "t": "gin",       "en": "to eat",    "audio": "sara-i-ex" },
    { "thai": "เผ็ด",    "t": "phèt",      "en": "spicy",     "audio": "quiz-phet" },
    { "thai": "แพง",    "t": "phaaeng",   "en": "expensive", "audio": "quiz-phaaeng" },
    { "thai": "ถูก",     "t": "thùuk",     "en": "cheap",     "audio": "quiz-thuuk" },
    { "thai": "ใกล้",    "t": "glâi",      "en": "near",      "audio": "quiz-glai-near" },
    { "thai": "ไกล",    "t": "glai",      "en": "far",       "audio": "quiz-glai-far" },
    { "thai": "เสื้อ",    "t": "sûea",      "en": "shirt",     "audio": "quiz-suea" },
    { "thai": "หนังสือ", "t": "nǎng-sǔue", "en": "book",      "audio": "quiz-nangsuue", "note": "silent ห on the second syllable" },
    { "thai": "ยาก",    "t": "yâak",      "en": "difficult", "audio": "quiz-yaak" }
  ],

  "quizBNote": "Part B fills in the letters and vowels Part A doesn't reach — every word is one you've already met on the letter and vowel pages. The rarest letters (ฆ ฌ ฎ ฏ ฑ ฒ ณ ฐ ภ ษ ฬ) barely exist outside their own name-words — revisit their consonant pages to read those.",
  "quizB": [
    { "thai": "ใบไม้",  "t": "bai-máai", "en": "leaf",           "audio": "baw-baimaai-word" },
    { "thai": "อ่าง",    "t": "àang",     "en": "basin",          "audio": "aw-aang-word" },
    { "thai": "งู",      "t": "nguu",     "en": "snake",          "audio": "ngaw-nguu-word" },
    { "thai": "โซ่",     "t": "sôo",      "en": "chain",          "audio": "saw-soo-word" },
    { "thai": "ช้าง",    "t": "cháang",   "en": "elephant",       "audio": "chaw-chaang-word" },
    { "thai": "ฉิ่ง",     "t": "chìng",    "en": "small cymbals",  "audio": "chaw-ching-word" },
    { "thai": "ศาลา",   "t": "sǎa-laa",  "en": "pavilion",       "audio": "saw-saalaa-word" },
    { "thai": "นกฮูก",  "t": "nók-hûuk", "en": "owl",            "audio": "haw-nokhuuk-word" },
    { "thai": "หญิง",   "t": "yǐng",     "en": "woman",          "audio": "yaw-ying-word", "note": "silent ห" },
    { "thai": "แหวน",   "t": "wǎen",     "en": "ring",           "audio": "waw-waen-word", "note": "silent ห" },
    { "thai": "ฝา",     "t": "fǎa",      "en": "lid",            "audio": "faw-faa-word" },
    { "thai": "ฟัน",     "t": "fan",      "en": "tooth",          "audio": "faw-fan-word" },
    { "thai": "เธอ",    "t": "thuhr",     "en": "she / you",      "audio": "sara-oe-ex" },
    { "thai": "ทำ",     "t": "tham",     "en": "to do",          "audio": "sara-am-ex" },
    { "thai": "คุณ",    "t": "khun",     "en": "you",            "audio": "sara-u-ex" },
    { "thai": "ใจ",     "t": "jai",      "en": "heart",          "audio": "sara-ai-maimuan-ex" },
    { "thai": "จะ",     "t": "jà",       "en": "will",           "audio": "sara-a-ex" },
    { "thai": "เพลง",   "t": "phleeng",  "en": "song",           "audio": "sara-ee-ex" },
    { "thai": "โต",     "t": "dtoo",     "en": "big",            "audio": "sara-oo-ex" },
    { "thai": "โต๊ะ",    "t": "dtó",      "en": "table",          "audio": "sara-o-ex" },
    { "thai": "เตะ",    "t": "dtè",      "en": "to kick",        "audio": "sara-e-ex" },
    { "thai": "แกะ",    "t": "gàe",      "en": "sheep",          "audio": "sara-ae-ex" },
    { "thai": "เกาะ",   "t": "gàw",      "en": "island",         "audio": "sara-aw-short-ex" },
    { "thai": "เยอะ",   "t": "yúh",      "en": "a lot",          "audio": "sara-oe-short-ex" },
    { "thai": "มือ",     "t": "muue",     "en": "hand",           "audio": "sara-uue-ex" },
    { "thai": "ถึง",     "t": "thǔeng",   "en": "to reach",       "audio": "sara-ue-ex" },
    { "thai": "กลัว",    "t": "glua",     "en": "afraid",         "audio": "sara-ua-ex" },
    { "thai": "เรียน",   "t": "rian",     "en": "to study",       "audio": "sara-ia-ex" },
    { "thai": "เอา",    "t": "ao",       "en": "to take",        "audio": "sara-ao-ex" },
    { "thai": "ฤดู",     "t": "rúe-duu",  "en": "season",         "audio": "rue-ex" }
  ],

  "quizCNote": "10 short sentences, all beginner words. Same drill: read each one aloud, tone by tone, then check by ear and mark yourself.",
  "quizC": [
    { "thai": "ผมกินข้าว",     "t": "phǒm gin khâao",        "en": "I eat rice.",                 "audio": "qs-01" },
    { "thai": "หมาตัวใหญ่",    "t": "mǎa dtua yài",          "en": "The dog is big.",             "audio": "qs-02" },
    { "thai": "ห้องร้อนมาก",    "t": "hâwng ráwn mâak",       "en": "The room is very hot.",       "audio": "qs-03" },
    { "thai": "ไปตลาดไหม",    "t": "bpai dtà-làat mǎi",     "en": "Are you going to the market?","audio": "qs-04" },
    { "thai": "อาหารแพง",     "t": "aa-hǎan phaaeng",       "en": "The food is expensive.",      "audio": "qs-05" },
    { "thai": "เขาชอบเพลงช้า", "t": "khǎo châwp phleeng cháa","en": "He likes slow songs.",       "audio": "qs-06" },
    { "thai": "วันนี้ฝนตก",      "t": "wan-níi fǒn dtòk",      "en": "It's raining today.",         "audio": "qs-07" },
    { "thai": "เสื้อสีแดง",      "t": "sûea sǐi daaeng",       "en": "A red shirt.",                "audio": "qs-08" },
    { "thai": "ขอกาแฟหน่อย",  "t": "khǎw gaa-faae nòi",     "en": "A coffee, please.",           "audio": "qs-09" },
    { "thai": "พ่อซื้อรถใหม่",   "t": "phâw súue rót mài",     "en": "Dad buys a new car.",         "audio": "qs-10" }
  ]
};
