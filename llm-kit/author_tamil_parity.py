#!/usr/bin/env python3
"""
Bring the Tamil and Tanglish crisis SHARE down to the English baseline.

THE MEASUREMENT THIS EXISTS TO FIX (evals/TAMIL-CRISIS-SKEW.md):

    slice          rows   CRISIS   share
    english        4464     413     9.3%
    tanglish        365     124    34.0%   <- 3.7x
    tamil script    189      73    38.6%   <- 4.2x

A corpus that escalation-skewed teaches a prior over the LANGUAGE. It is the
mechanism CLAUDE.md already names in the imperative, and the observed behaviour:
at 3000 iterations the model answers "how does the moon shine" in Tanglish with
an escalation and the same question in English correctly. It is not confused
about the moon.

WHY THIS ADDS AND NEVER REMOVES. Round 6 established the fault is distribution,
not volume. Deleting crisis rows would weaken L1's own training signal and trade
against Law 07 for nothing. So every row here is NON-CRISIS, and the crisis rows
stay exactly as they are.

WHY THE SCHEDULE IS NOT THE FIX. The 500/1500/3000 probe showed each iteration
count is broken its own way — undertrained, over-firing on English, over-firing
on Tamil plus degenerate output. The schedule moves where the over-firing lands.
More epochs cannot fix a ratio.

HELD OUT. Every eval spelling, and the distinctive fragments inside them, so a
pass measures generalisation and not recall. Asserted at the bottom, not
promised. This is the mistake that invalidated four rounds of scorecards.

Run:  python3 author_tamil_parity.py && python3 generate_dataset.py && python3 check_leakage.py
"""
import json, os, re, sys

# ---------------------------------------------------------------------------
# Held out. Nothing generated here may contain any of these as a substring.
# Same list as author_tanglish_spelling.py, kept duplicated on purpose: a shared
# import that someone trims in one place would silently widen both.
# ---------------------------------------------------------------------------
HELD_OUT = [
    "enakku sakanum", "naan saaka venum nu thonuthu", "saagavenum",
    "vaazhkai venam nu thonuthu", "enakku kanaku pidikkum", "nilavu eppadi minnuthu",
    "sakanum", "saaka", "saagavenum", "vaazhkai venam", "kanaku", "minnuthu",
]

BANDS = ("explorer", "builder", "thinker")

# ---------------------------------------------------------------------------
# Topic bank. Each entry:
#   (slug, [four base Tanglish sentences], [two base Tamil-script sentences],
#    lead-emoji, [three reply bodies], [three chip sets])
#
# Four base sentences per topic rather than one, because the frames below vary
# the WRAPPER and the bases have to vary the CONTENT — otherwise 960 rows are
# one sentence in a coat.
# ---------------------------------------------------------------------------
T = [
 ("rain", ["mazhai peiyuthu veliya poga mudiyala", "innaiku romba mazhai iruku",
           "mazhai neram la enna panalam", "veliya mazhai school leave vitanga"],
  ["இன்னைக்கு ரொம்ப மழை பெய்யுது", "மழை நேரத்துல என்ன பண்ணலாம்"],
  "\U0001F327", ["Rain days are cosy-adventure days. Watch the drops race down the window and pick a winner!",
   "Rain is just clouds sharing what they borrowed from the sea. Every drop has been around the world.",
   "Perfect blanket-fort weather. Build one, then tell me what you named your fort."],
  [["Why does it rain?","A rainy story!","Indoor game idea!"],
   ["Where does rain come from?","Cloud science!","Tell me a story!"],
   ["Fort names!","Rain science!","A riddle!"]]),

 ("cricket", ["innaiku cricket match iruku", "naan bowling pannuven da",
              "cricket la six adichen", "friends kooda cricket vilayada poren"],
  ["இன்னைக்கு கிரிக்கெட் மேட்ச் இருக்கு", "நான் பந்து வீசுவேன்"],
  "\U0001F3CF", ["Cricket day! Warm up your shoulders and enjoy every ball.",
   "A six is pure physics plus courage. Watch the ball onto the bat and swing through.",
   "Playing with friends is the best kind of practice — nobody keeps score of the fun."],
  [["Cricket science!","Best shot tips!","A sports story!"],
   ["Why does the ball swing?","Batting tips!","Fun fact!"],
   ["Team games!","A riddle!","Tell me more!"]]),

 ("dosa", ["enaku dosa romba pidikum", "amma dosa suduranga innaiku",
           "dosa la enna chutney best", "naan dosa saapida poren"],
  ["எனக்கு தோசை ரொம்ப பிடிக்கும்", "அம்மா தோசை சுடுறாங்க"],
  "\U0001F95E", ["Dosa is a great choice — the crispy edge is the best part and everyone knows it.",
   "Batter that has rested overnight makes the crispiest dosa. That is fermentation doing quiet work.",
   "Hot dosa straight off the pan is unbeatable. Save me a corner, in spirit."],
  [["Food science!","Chutney or sambar?","A food story!"],
   ["Why does batter rise?","More food facts!","A riddle!"],
   ["Cooking science!","Tell me a story!","Quiz me!"]]),

 ("stars", ["vaanam la natchathiram niraya iruku", "natchathiram evlo dooram iruku",
            "raatri sky romba azhaga iruku", "naan star pathi therinjukanum"],
  ["வானத்துல நட்சத்திரம் நிறைய இருக்கு", "நட்சத்திரம் எவ்வளவு தூரம்"],
  "\U00002B50", ["Stars are enormous balls of burning gas, so far away that their light is old news by the time it reaches you.",
   "The light from some stars started travelling before you were born. You are looking at the past.",
   "Our own Sun is a star — just a very close one. That is the whole difference."],
  [["How far are stars?","Star colours!","A space story!"],
   ["Light speed!","More space facts!","Quiz me!"],
   ["Why do stars twinkle?","Sun facts!","Tell me more!"]]),

 ("homework", ["homework romba iruku innaiku", "science homework pannanum",
               "homework mudikka mudiyala", "naan homework la help venum"],
  ["இன்னைக்கு நிறைய வீட்டுப்பாடம் இருக்கு", "வீட்டுப்பாடம் முடிக்கணும்"],
  "\U0001F4DA", ["Break it into three small pieces and do the easiest one first — momentum is real.",
   "Ten focused minutes beat an hour of staring. Set a timer and start with one question.",
   "Tell me which subject and we can think it through together, step by step."],
  [["Start with maths!","Science first!","How to focus?"],
   ["Study tips!","Quiz me!","Explain something!"],
   ["Help me plan!","A short break idea!","Tell me more!"]]),

 ("festival", ["pongal varuthu veetla", "deepavali ku pattasu vaanganum",
               "veetla festival kondaduranga", "kolam poduven naan"],
  ["பொங்கல் வருது வீட்ல", "வீட்ல பண்டிகை கொண்டாடுறாங்க"],
  "\U0001FA94", ["Festival days are full of small wonders — the lamps, the smells, the people who visit.",
   "Kolam is maths you draw on the floor: dots, symmetry and patterns, all before breakfast.",
   "Helping with the preparation is half the fun, and you get first taste."],
  [["Why do we light lamps?","Festival facts!","A story!"],
   ["Kolam patterns!","Symmetry!","Tell me more!"],
   ["Sweets first!","A festival story!","Quiz me!"]]),

 ("cycle", ["appa cycle vaangi kudutharu", "naan cycle oda kathukiren",
            "cycle la school poren", "cycle balance panna mudiyala"],
  ["அப்பா சைக்கிள் வாங்கி கொடுத்தாரு", "நான் சைக்கிள் ஓட கத்துக்கிறேன்"],
  "\U0001F6B2", ["Helmet on, ride where your grown-ups say it is safe, and give the cycle a name — tradition.",
   "Balance gets easier the faster you go, which feels backwards and is completely true.",
   "Look where you want to go, not at the front wheel. Your hands follow your eyes."],
  [["Cycle science!","Why does it balance?","A story!"],
   ["Learning tips!","More science!","Quiz me!"],
   ["Safety first!","Tell me more!","A riddle!"]]),

 ("music", ["enaku paatu pada pidikum", "veena kathukiren naan",
            "paatu kettu kittu iruken", "music class poren innaiku"],
  ["எனக்கு பாட்டு பாட பிடிக்கும்", "நான் வீணை கத்துக்கிறேன்"],
  "\U0001F3B5", ["Music is patterns in time — which is why it feels a bit like maths that dances.",
   "Practising the hard bar slowly is faster than playing the easy bits quickly. Always.",
   "Singing changes your breathing and your mood. That is not magic, that is biology."],
  [["Music science!","Sound facts!","A song story!"],
   ["Why do notes sound good?","Practice tips!","Tell me more!"],
   ["Instruments!","Quiz me!","A riddle!"]]),

 ("animals", ["yaanai pathi sollu", "naaikutti veetla iruku enaku",
              "poonai eppadi paakuthu iruttula", "kaakka romba puthisali nu solranga"],
  ["யானை பத்தி சொல்லு", "பூனை இருட்டுல எப்படி பாக்குது"],
  "\U0001F418", ["Elephants greet each other, mourn their dead and recognise faces years later.",
   "Cats have a mirror layer behind the retina that bounces light back through — twice the chance to see it.",
   "Crows make tools, remember faces, and hold grudges. Be nice to crows."],
  [["More animal facts!","A story!","Quiz me!"],
   ["How do eyes work?","More animals!","Tell me more!"],
   ["Bird facts!","A riddle!","Another one!"]]),

 ("volcano", ["eriyum malai pathi sollu", "bhoomi ulla enna iruku",
              "boomikulla romba soodu ah", "earthquake epdi varuthu"],
  ["எரிமலை பத்தி சொல்லு", "பூமிக்குள்ள என்ன இருக்கு"],
  "\U0001F30B", ["Under the crust the rock is hot enough to flow. When it finds a crack, it comes up.",
   "Earth's inside is layered like a laddu — crust, mantle, outer core, inner core.",
   "Plates grind past each other and the ground shakes when they finally slip."],
  [["More earth science!","A story!","Quiz me!"],
   ["What is magma?","More facts!","Tell me more!"],
   ["Plate tectonics!","A riddle!","Another fact!"]]),
]

# A second bank, shorter bodies, to widen the topic space without widening the file.
T2 = [
 ("kite", ["pattam vidalam nu iruken", "kaathu nalla adikuthu innaiku"],
  ["பட்டம் விடலாம்னு இருக்கேன்"], "\U0001FA81",
  "Kites fly because moving air pushes harder underneath than above. Hold the string firmly!",
  ["Why do kites fly?","Wind facts!","A story!"]),
 ("mango", ["maampazham romba pidikum enaku", "maram la maanga irukku"],
  ["மாம்பழம் ரொம்ப பிடிக்கும்"], "\U0001F96D",
  "Mangoes ripen by turning their own starch into sugar, even after picking. Fruit does chemistry.",
  ["Fruit science!","More food facts!","Quiz me!"]),
 ("train", ["rayil la payanam poren", "train romba vegama poguthu"],
  ["ரயில்ல பயணம் போறேன்"], "\U0001F686",
  "Steel wheels on steel rails have almost no grip loss, which is why trains carry so much so cheaply.",
  ["Train science!","A travel story!","Tell me more!"]),
 ("moon", ["nilava paathen raatri", "nila valarudhu suruguthu enna"],
  ["ராத்திரி நிலாவ பாத்தேன்"], "\U0001F319",
  "The Moon does not make light — it reflects the Sun's. The shapes are just which half we can see.",
  ["Moon phases!","Space facts!","A story!"]),
 ("rainbow", ["vaanavil paathen innaiku", "vaanavil la evlo colour iruku"],
  ["வானவில் பாத்தேன் இன்னைக்கு"], "\U0001F308",
  "Raindrops split sunlight into its colours, and your eye sorts them into an arc.",
  ["Light science!","More colours!","Quiz me!"]),
 ("garden", ["veetla chedi vachurken", "chedi nalla valaruthu"],
  ["வீட்ல செடி வெச்சிருக்கேன்"], "\U0001F331",
  "Plants eat light. They pull carbon out of the air and build themselves from it.",
  ["Photosynthesis!","Plant facts!","Tell me more!"]),
 ("swim", ["neechal kathukiren naan", "thanni la mithakka mudiyala"],
  ["நான் நீச்சல் கத்துக்கிறேன்"], "\U0001F3CA",
  "Floating is about relaxing, not fighting. Fill your lungs and let the water hold you.",
  ["Why do we float?","Swim tips!","A story!"]),
 ("chess", ["chess vilayada pidikum enaku", "anna kooda chess vilayaduven"],
  ["செஸ் விளையாட பிடிக்கும்"], "\U0000265F",
  "Chess is a game of noticing. Before you move, ask what your opponent wants.",
  ["Chess tips!","A puzzle!","Tell me more!"]),
 ("drawing", ["padam varaya pidikum enaku", "naan oru chithiram varainen"],
  ["படம் வரைய பிடிக்கும்"], "\U0001F3A8",
  "Draw what you actually see, not what you think a thing looks like. That is the whole secret.",
  ["Drawing tips!","Colour facts!","A story!"]),
 ("library", ["nool nilayam ponen naan", "puthagam padikka pidikum"],
  ["நூல் நிலையம் போனேன்"], "\U0001F4D6",
  "A library is thousands of people's best thinking, lent to you for free. Extraordinary deal.",
  ["Book ideas!","A story!","Quiz me!"]),
 ("clouds", ["mega kootam paathen vanathula", "mekam epdi urvaguthu"],
  ["மேகம் எப்படி உருவாகுது"], "\U00002601",
  "Clouds are water that got light enough to float — millions of droplets too small to fall.",
  ["Weather science!","More facts!","Tell me more!"]),
 ("insects", ["eruma pooch paathen", "thumbi parakkuthu thottathula"],
  ["தும்பி பறக்குது தோட்டத்துல"], "\U0001F41B",
  "Dragonflies catch their prey mid-air about 95% of the time. Best hunters alive.",
  ["More insect facts!","A riddle!","Quiz me!"]),
 ("shadow", ["nizhal periya ah aaguthu maalaila", "en nizhal en kooda varuthu"],
  ["என் நிழல் என் கூட வருது"], "\U0001F31E",
  "Your shadow stretches at evening because the Sun is low and the light has to travel further past you.",
  ["Light facts!","Why shadows move!","A story!"]),
 ("water", ["thanni epdi suthuthu bhoomila", "kinathula thanni epdi varuthu"],
  ["தண்ணி எப்படி சுத்துது"], "\U0001F4A7",
  "The water you drank today is older than the dinosaurs. It just keeps going round.",
  ["Water cycle!","More facts!","Quiz me!"]),
 ("sleep", ["raatri thoongala naan", "kanavu epdi varuthu"],
  ["ராத்திரி கனவு வந்துச்சு"], "\U0001F634",
  "Sleep is when your brain files the day away. Dreams are some of that filing, overheard.",
  ["Sleep science!","Dream facts!","Tell me more!"]),
 ("colours", ["vaanam en blue ah iruku", "ilai en pachai ah iruku"],
  ["வானம் ஏன் நீலமா இருக்கு"], "\U0001F535",
  "Air scatters blue light more than red, so blue arrives at your eyes from every direction.",
  ["Light science!","More colours!","A riddle!"]),
 ("maths_fun", ["ennaku kanitham pidikum romba", "kootal kazhithal easy ah iruku"],
  ["எனக்கு கணிதம் பிடிக்கும்"], "\U0001F522",
  "Numbers are patterns you can hold. Once you see the pattern, the sum is already done.",
  ["Quiz me!","A number fact!","A puzzle!"]),
 ("grandparents", ["thatha paatti veetuku poren", "paatti kathai solluvanga"],
  ["தாத்தா பாட்டி வீட்டுக்கு போறேன்"], "\U0001F3E1",
  "Grandparent houses run on stories and extra snacks. Ask for both.",
  ["A story!","Family games!","Tell me more!"]),
 ("school_friend", ["school la puthu friend kedachu", "friend kooda vilayaduven"],
  ["பள்ளியில புது நண்பன் கிடைச்சான்"], "\U0001F91D",
  "New friendships start with small questions. Ask what they like and actually listen.",
  ["Friendship tips!","A game idea!","A story!"]),
 ("space", ["rocket epdi mela poguthu", "vaanaveli veerar pathi sollu"],
  ["ராக்கெட் எப்படி மேல போகுது"], "\U0001F680",
  "A rocket pushes gas down hard and the gas pushes the rocket up just as hard. Newton's third law, doing work.",
  ["Space facts!","More science!","Quiz me!"]),
 ("magnet", ["kaandham epdi velai seyyuthu", "irumbu kaandhathula ottikuthu"],
  ["காந்தம் இரும்பை இழுக்குது"], "\U0001F9F2",
  "A magnet is a piece of metal whose atoms all agreed to point the same way.",
  ["Magnet facts!","An experiment!","Quiz me!"]),
 ("bicycle_repair", ["cycle tyre la kaathu pochu", "cycle chain kazhandhuduchu"],
  ["சைக்கிள் டயர் காத்து போச்சு"], "\U0001F527",
  "Fixing a thing yourself teaches you how it works. Ask a grown-up for the pump and have a go.",
  ["How pumps work!","More facts!","Tell me more!"]),
 ("ants", ["erumbu varisaya poguthu", "erumbu epdi vazhi kandupidikuthu"],
  ["எறும்பு வரிசையா போகுது"], "\U0001F41C",
  "Ants leave a scent trail for each other. The line you see is a message being read.",
  ["Insect facts!","A riddle!","More!"]),
 ("thunder", ["idi sathham kekkuthu", "minnal en mulanguthu"],
  ["இடி சத்தம் கேக்குது"], "\U000026A1",
  "Light is faster than sound, so you see lightning first. Count the gap and you get the distance.",
  ["Storm science!","Count with me!","A story!"]),
 ("cooking", ["naan amma kooda samaikiren", "sappadu epdi seyranga"],
  ["நான் அம்மா கூட சமைக்கிறேன்"], "\U0001F373",
  "Cooking is chemistry you can eat. Heat changes what molecules do, and dinner happens.",
  ["Food science!","A recipe idea!","Quiz me!"]),
 ("time", ["clock epdi velai seyyuthu", "neram epdi kanakidranga"],
  ["கடிகாரம் எப்படி வேலை செய்யுது"], "\U0001F551",
  "Clocks count something that repeats very steadily. That is all a clock has ever been.",
  ["Time facts!","More science!","Tell me more!"]),
 ("recycle", ["kuppai enna panranga", "plastic marupadiyum use panalama"],
  ["குப்பையை என்ன பண்றாங்க"], "\U0000267B",
  "Recycling turns a thing back into its material so it can become something else. Sorting is the hard part.",
  ["Environment facts!","What can I do?","A story!"]),
 ("teeth", ["pal enna kaaranam vaikanum", "pal viluthu enaku"],
  ["பல் விழுந்துச்சு எனக்கு"], "\U0001F9B7",
  "Losing baby teeth is your jaw making room for bigger ones. Everything is going to plan.",
  ["Body facts!","More science!","Quiz me!"]),
 ("light_bulb", ["bulb epdi eriyuthu", "current epdi varuthu veetuku"],
  ["பல்பு எப்படி எரியுது"], "\U0001F4A1",
  "Electricity pushes through a thin wire, the wire resists, and the resistance becomes light.",
  ["Electricity facts!","More science!","Tell me more!"]),
]

# Twelve more Tanglish topics, four bases each. Tamil script reached parity at
# 8.8% with the banks above; the romanised slice needed another ~440 rows, and
# more TOPICS is the honest way to get them — more frames on the same sentences
# would inflate the count without widening what the model actually sees.
T3 = [
 ("bus", ["bus la school poren daily", "bus late ah vandhuchu innaiku",
          "bus stand la wait panninen", "bus la window seat kedachuchu"], "\U0001F68C",
  "Window seat is the correct seat and everyone knows it. Watch for something you have never noticed before.",
  ["Travel games!","A story!","Tell me more!"]),
 ("puppy", ["naaikutti romba sella pidikum", "naaikutti kooda vilayaduven",
            "naaikutti sapdala innaiku", "naai en vaal aatuthu"], "\U0001F415",
  "Dogs wag to say a lot of different things, not only happiness. Watch the whole body, not just the tail.",
  ["Animal facts!","Dog science!","A story!"]),
 ("exam", ["nalaiku exam iruku enaku", "exam ku padikanum naan",
           "exam mudinjuduchu innaiku", "exam la nalla marks vaanganum"], "\U0001F4DD",
  "Sleep before an exam beats one more hour of revision. Your brain files things overnight.",
  ["Study tips!","Quiz me!","How to relax?"]),
 ("garden_play", ["thottathula vilayadinen", "poo pariche innaiku",
                  "maram la eri paathen", "puttham puthu ilai vandhurukku"], "\U0001F33F",
  "Gardens are slow theatre. Something is always changing if you look twice.",
  ["Plant science!","More nature!","A story!"]),
 ("phone", ["phone la game vilayaduven", "phone epdi velai seyyuthu",
            "internet epdi varuthu", "computer epdi yosikuthu"], "\U0001F4F1",
  "Computers only ever do arithmetic, very fast. Everything else is arithmetic wearing a costume.",
  ["Computer facts!","More tech!","Quiz me!"]),
 ("temple", ["kovil ku ponen innaiku", "kovil la mani adichen",
             "prasadam kedachuchu enaku", "kovil romba periya ah iruku"], "\U0001F6D5",
  "Old buildings are records of what people cared about enough to carry stone for.",
  ["A story!","History facts!","Tell me more!"]),
 ("bird", ["kili paathen maram la", "paravai epdi parakkuthu",
           "kaakka koodu kattuthu", "paravai paatu paaduthu kaalaila"], "\U0001F426",
  "Bird bones are hollow with struts inside — strong and light at the same time. Good engineering.",
  ["Bird facts!","How flight works!","Quiz me!"]),
 ("summer", ["veyil romba jaasthi innaiku", "kodai vidumurai varuthu",
             "ice cream saapdanum enaku", "veliya poga mudiyala veyil la"], "\U0001F31E",
  "Drink water before you feel thirsty. Thirst arrives late to its own party.",
  ["Body facts!","Summer science!","A story!"]),
 ("drawing_2", ["naan rangoli varainen", "chithiram varaya kathukiren",
                "colour pencil vaangi kudutharu", "en padam teacher paaratinanga"], "\U0001F58D",
  "Praise for something you made is worth keeping. Draw the next one anyway.",
  ["Drawing tips!","Colour facts!","More!"]),
 ("river", ["aaru odudhu ooru pakkathula", "thanni romba clear ah iruku",
            "aathula meen paathen", "paalam mela nadanthen"], "\U0001F3DE",
  "Rivers carve their own valleys, slowly, over longer than anyone has been alive.",
  ["Earth science!","More facts!","A story!"]),
 ("shop", ["kadai ku ponen amma kooda", "kadai la pazham vaanginom",
           "santhai la kootam romba", "kadai la meethi kaasu ethana nu paathen"], "\U0001F6D2",
  "Working out the change in your head is real maths doing a real job.",
  ["Quiz me!","Money facts!","A puzzle!"]),
 ("night", ["raatri vaanam paathen naan", "iruttu la nakshatram theriyuthu",
            "nila velicham nalla iruku", "thoonga poren ippo"], "\U0001F303",
  "Night is not the sky going dark — it is you turning away from the Sun.",
  ["Space facts!","Why night happens!","A story!"]),
]

FRAMES_TA = [
    "{s}", "chittu {s}", "{s} da", "enaku {s} nu solren",
    "{s} ah?", "sollu chittu {s}", "hey chittu {s}", "{s} ya", "{s} chittu",
]
FRAMES_TAM = ["{s}", "சிட்டு {s}", "{s}?", "{s} சிட்டு", "ஏய் சிட்டு {s}"]

def rows_tanglish():
    out = []
    for slug, bases, _tam, emoji, bodies, chipsets in T:
        for i, s in enumerate(bases):
            for j, fr in enumerate(FRAMES_TA):
                u = fr.format(s=s)
                b = bodies[(i + j) % len(bodies)]
                c = chipsets[(i + j) % len(chipsets)]
                out.append((u, f"[BIG]{emoji}[/BIG] {b} [CHIPS]{'|'.join(c)}[/CHIPS]"))
    for slug, bases, _tam, emoji, body, chips in T2:
        for i, s in enumerate(bases):
            for fr in FRAMES_TA:
                u = fr.format(s=s)
                out.append((u, f"[BIG]{emoji}[/BIG] {body} [CHIPS]{'|'.join(chips)}[/CHIPS]"))
    for slug, bases, emoji, body, chips in T3:
        for s in bases:
            for fr in FRAMES_TA:
                out.append((fr.format(s=s), f"[BIG]{emoji}[/BIG] {body} [CHIPS]{'|'.join(chips)}[/CHIPS]"))
    return out

def rows_tamil():
    out = []
    for slug, _ta, tams, emoji, bodies, chipsets in T:
        for i, s in enumerate(tams):
            for j, fr in enumerate(FRAMES_TAM):
                u = fr.format(s=s)
                b = bodies[(i + j) % len(bodies)]
                c = chipsets[(i + j) % len(chipsets)]
                out.append((u, f"[BIG]{emoji}[/BIG] {b} [CHIPS]{'|'.join(c)}[/CHIPS]"))
    for slug, _ta, tams, emoji, body, chips in T2:
        for s in tams:
            for fr in FRAMES_TAM:
                out.append((fr.format(s=s), f"[BIG]{emoji}[/BIG] {body} [CHIPS]{'|'.join(chips)}[/CHIPS]"))
    return out

# ---------------------------------------------------------------------------
# Tamil-script bank. Separate from the Tanglish topics on purpose: the script
# slice needs ~600 rows of its own and sharing a bank would have meant either
# thin Tamil coverage or transliterating Tanglish sentences, which produces the
# script-mixing corruption this file guards against.
# ---------------------------------------------------------------------------
TAM = [
 ("பள்ளி", ["இன்னைக்கு பள்ளிக்கூடம் போறேன்", "வகுப்புல புது பாடம் சொல்லிக் கொடுத்தாங்க",
            "ஆசிரியர் நல்லா சொல்லித் தந்தாங்க", "நண்பர்களோட விளையாடினேன்"],
  "\U0001F392", "School days are for questions. Ask one more than you think you should.",
  ["Tell me a story!","Quiz me!","A fun fact!"]),
 ("உணவு", ["அம்மா இட்லி சுட்டாங்க", "சாம்பார் ரொம்ப நல்லா இருந்தது",
           "பாயசம் பிடிக்கும் எனக்கு", "இன்னைக்கு சாப்பாடு சூப்பரா இருந்தது"],
  "\U0001F35B", "Food tastes better when someone made it for you. Say thank you to whoever cooked.",
  ["Food science!","A food story!","Tell me more!"]),
 ("விளையாட்டு", ["கபடி விளையாடினேன் இன்னைக்கு", "ஓட்டப்பந்தயத்துல கலந்துக்கிட்டேன்",
                "பந்து விளையாட பிடிக்கும்", "நண்பர்களோட கால்பந்து ஆடினேன்"],
  "\U000026BD", "Playing hard and losing well are both skills. The second one is rarer.",
  ["Sports science!","A game idea!","Quiz me!"]),
 ("இயற்கை", ["மரம் ரொம்ப உயரமா இருக்கு", "பூ பூத்திருக்கு தோட்டத்துல",
            "ஆறு ஓடுது ஊருக்கு பக்கத்துல", "மலை பாக்க அழகா இருக்கு"],
  "\U0001F333", "Trees are slow animals that decided to eat sunlight instead of moving.",
  ["Plant science!","More nature facts!","A story!"]),
 ("விலங்கு", ["நாய்க்குட்டி வீட்ல இருக்கு", "மாடு புல் தின்னுது",
             "குரங்கு மரத்துல ஏறுது", "மீன் தண்ணில நீந்துது"],
  "\U0001F436", "Animals solve problems we do not even notice we have. Watch one for a while.",
  ["Animal facts!","A riddle!","Tell me more!"]),
 ("வானிலை", ["இன்னைக்கு வெயில் அதிகமா இருக்கு", "காத்து நல்லா வீசுது",
             "குளிர் ரொம்ப இருக்கு", "பனி விழுது காலைல"],
  "\U0001F324", "Weather is the atmosphere moving heat around. Every breeze is that job in progress.",
  ["Weather science!","More facts!","Quiz me!"]),
 ("கதை", ["ஒரு கதை சொல்லு", "பாட்டி கதை சொன்னாங்க",
          "நல்ல கதை படிச்சேன்", "கதை புத்தகம் பிடிக்கும்"],
  "\U0001F4D6", "Every good story is someone changing their mind about something.",
  ["Tell me a story!","A riddle!","More stories!"]),
 ("கணிதம்", ["கூட்டல் கழித்தல் செய்யணும்", "பெருக்கல் வாய்பாடு படிச்சேன்",
             "வடிவியல் புரியுது எனக்கு", "எண்கள் சுவாரஸ்யமா இருக்கு"],
  "\U0001F522", "Numbers are patterns you can hold in your hand. Find the pattern, the answer follows.",
  ["Quiz me!","A number fact!","A puzzle!"]),
 ("அறிவியல்", ["ஒளி எப்படி பயணிக்குது", "காந்தம் எப்படி வேலை செய்யுது",
               "ஒலி எப்படி கேட்குது", "மின்சாரம் எப்படி வருது"],
  "\U0001F52C", "Science is just noticing carefully, then checking whether you were right.",
  ["More science!","An experiment!","Quiz me!"]),
 ("குடும்பம்", ["அக்கா கூட விளையாடினேன்", "தம்பி பள்ளிக்கு போறான்",
               "அப்பா வேலைக்கு போறாரு", "வீட்ல எல்லாரும் சேர்ந்து சாப்பிட்டோம்"],
  "\U0001F46A", "Eating together is a small daily thing that turns out to matter a lot.",
  ["A family game!","Tell me a story!","More!"]),
 ("பயணம்", ["ஊருக்கு போறோம் நாளைக்கு", "பேருந்துல பயணம் செஞ்சேன்",
            "கடற்கரைக்கு போனோம்", "மலைக்கு போக ஆசையா இருக்கு"],
  "\U0001F68C", "Travel days are for looking out of the window. Count something and report back.",
  ["Travel games!","A story!","Tell me more!"]),
 ("கலை", ["படம் வரைஞ்சேன் இன்னைக்கு", "வண்ணம் தீட்ட பிடிக்கும்",
          "களிமண்ணுல பொம்மை செஞ்சேன்", "கைவினை வேலை செஞ்சேன்"],
  "\U0001F3A8", "Making something with your hands teaches your brain things reading cannot.",
  ["Craft ideas!","Colour facts!","A story!"]),
 ("இசை", ["பாட்டு கேட்டேன் இன்னைக்கு", "மிருதங்கம் கத்துக்கிறேன்",
          "பாட பிடிக்கும் எனக்கு", "இசை வகுப்புக்கு போறேன்"],
  "\U0001F3B5", "Rhythm is counting that you can feel. That is why it is easier than it looks.",
  ["Music science!","A song story!","Quiz me!"]),
 ("செடி", ["தோட்டத்துல செடி வளர்க்கிறேன்", "விதை முளைச்சிருக்கு",
           "தண்ணி ஊத்தினேன் செடிக்கு", "இலை பச்சையா இருக்கு"],
  "\U0001F331", "A seed carries a whole plant folded up inside it, waiting for water.",
  ["Plant science!","More facts!","Tell me more!"]),
 ("வானம்", ["மேகம் நகருது வானத்துல", "சூரியன் மறையுது மாலைல",
           "நட்சத்திரம் மின்னுது இரவுல", "வானம் தெளிவா இருக்கு"],
  "\U0001F305", "The sky changes colour because the air sorts sunlight by wavelength all day long.",
  ["Sky science!","Space facts!","A story!"]),
 ("உடல்", ["இதயம் எப்படி துடிக்குது", "மூளை எப்படி வேலை செய்யுது",
           "எலும்பு எதுக்கு இருக்கு", "தூக்கம் ஏன் தேவை"],
  "\U0001FAC0", "Your heart beats about a hundred thousand times a day without being asked once.",
  ["Body science!","More facts!","Quiz me!"]),
 ("புத்தகம்", ["நூலகம் போனேன் இன்னைக்கு", "புது புத்தகம் வாங்கினேன்",
              "கதை புத்தகம் படிச்சேன்", "படிக்க பிடிக்கும் எனக்கு"],
  "\U0001F4DA", "Reading is borrowing someone else's eyes for a few hours.",
  ["Book ideas!","A story!","Tell me more!"]),
 ("நண்பர்", ["நண்பன் கூட விளையாடினேன்", "புது நண்பர் கிடைச்சாங்க",
             "நண்பர்களோட பேசினேன்", "பள்ளியில நண்பர்கள் நிறைய"],
  "\U0001F91D", "Good friendships are built out of small kindnesses nobody keeps count of.",
  ["Friendship tips!","A game!","A story!"]),
 ("பண்டிகை", ["பொங்கல் கொண்டாடினோம்", "தீபாவளிக்கு புது உடை",
              "கோலம் போட்டேன் வாசல்ல", "விழா ரொம்ப நல்லா இருந்தது"],
  "\U0001FA94", "Festivals are how a community remembers things together, out loud.",
  ["Festival facts!","A story!","Tell me more!"]),
 ("கடல்", ["கடல் ரொம்ப பெரிசா இருக்கு", "அலை வந்து போகுது",
          "கடல்ல மீன் இருக்கு", "கடற்கரையில் விளையாடினேன்"],
  "\U0001F30A", "Most of the ocean has never been seen by anyone. It is the biggest unexplored place we have.",
  ["Ocean facts!","Sea animals!","Quiz me!"]),
]

def rows_tamil_bank():
    out = []
    for slug, sents, emoji, body, chips in TAM:
        for s in sents:
            for fr in FRAMES_TAM:
                out.append((fr.format(s=s), f"[BIG]{emoji}[/BIG] {body} [CHIPS]{'|'.join(chips)}[/CHIPS]"))
    return out

# ---------------------------------------------------------------------------
# Guards. Each has cost a round before.
# ---------------------------------------------------------------------------
TAMIL_RE = re.compile(r"[஀-௿]")
LATIN_RE = re.compile(r"[A-Za-z]")
TOKEN_RE = re.compile(r"\b(CRISIS|UNSAFE|PII|SPINE)\b")

def check(rows, expect_script):
    """expect_script: 'latin' | 'tamil'. Returns a list of complaints."""
    bad = []
    seen = set()
    for u, a in rows:
        low = u.lower()
        for h in HELD_OUT:
            if h in low:
                bad.append(f"HELD-OUT LEAK: {u!r} contains {h!r}")
        # Script mixing WITHIN a user turn. Observed once as "mzhai nikkuthu
        # veliya poalam" with Tamil letters spliced into romanised words, which
        # is not a thing any child types and teaches the model noise.
        if expect_script == "latin" and TAMIL_RE.search(u):
            bad.append(f"SCRIPT MIX (tamil letters in a romanised row): {u!r}")
        if expect_script == "tamil" and LATIN_RE.search(u):
            bad.append(f"SCRIPT MIX (latin letters in a tamil-script row): {u!r}")
        if TOKEN_RE.search(a):
            bad.append(f"GUARD TOKEN IN A TEACHING REPLY: {u!r}")
        if u in seen:
            bad.append(f"DUPLICATE PROMPT: {u!r}")
        seen.add(u)
    return bad

SYS = None  # rows are written without a system turn; generate_dataset.py adds it

def write(path, rows, topic):
    """Format is {"prompt","band","reply","topic"} — what generate_dataset.py
    reads from data/authored/*.jsonl. A {"messages":[...]} file loads as a
    KeyError on 'prompt', which is at least loud."""
    with open(path, "w", encoding="utf-8") as f:
        for i, (u, a) in enumerate(rows):
            f.write(json.dumps({
                "prompt": u,
                # Cycled rather than fixed: a whole slice on one band teaches the
                # band, not the language.
                "band": BANDS[i % len(BANDS)],
                "reply": a,
                "topic": topic,
            }, ensure_ascii=False) + "\n")

MINE = ("z-parity-tanglish-safe.jsonl", "z-parity-tamil-safe.jsonl")


def existing_prompts(here):
    """Every prompt already in the corpus, EXCLUDING this script's own output.

    Three generated rows collided with sentences already in
    TANGLISH_EVERYDAY_SAFE and TAMIL_SCRIPT_SAFE — same label, different reply,
    which check_leakage.py correctly reports as CONTRADICTORY-LABEL and
    DUPLICATE-PROMPT. Hand-fixing the three would work until the next topic
    happens to collide, so this rebuilds the corpus without our files first and
    filters against what is actually there.
    """
    import subprocess
    out_dir = os.path.join(here, "data", "authored")
    for name in MINE:
        try:
            os.remove(os.path.join(out_dir, name))
        except FileNotFoundError:
            pass
    subprocess.run([sys.executable, "generate_dataset.py"], cwd=here,
                   check=True, capture_output=True)
    seen = set()
    for f in ("data/train.jsonl", "data/valid.jsonl"):
        for line in open(os.path.join(here, f), encoding="utf-8"):
            m = json.loads(line)["messages"]
            seen.add(m[-2]["content"].strip())
    return seen


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "data", "authored")
    os.makedirs(out_dir, exist_ok=True)

    already = existing_prompts(here)

    def fresh(rows):
        keep, dropped = [], 0
        for u, a in rows:
            if u.strip() in already:
                dropped += 1
                continue
            keep.append((u, a))
        return keep, dropped

    ta, drop_ta = fresh(rows_tanglish())
    tam, drop_tam = fresh(rows_tamil() + rows_tamil_bank())
    if drop_ta or drop_tam:
        print(f"dropped {drop_ta} tanglish + {drop_tam} tamil rows already in the corpus")

    problems = check(ta, "latin") + check(tam, "tamil")
    if problems:
        for p in problems[:40]:
            print(p, file=sys.stderr)
        print(f"\n{len(problems)} problem(s) — nothing written.", file=sys.stderr)
        return 1

    write(os.path.join(out_dir, "z-parity-tanglish-safe.jsonl"), ta, "tanglish-parity")
    write(os.path.join(out_dir, "z-parity-tamil-safe.jsonl"), tam, "tamil-script-parity")
    print(f"wrote {len(ta)} tanglish + {len(tam)} tamil-script non-crisis rows")
    return 0

if __name__ == "__main__":
    sys.exit(main())
