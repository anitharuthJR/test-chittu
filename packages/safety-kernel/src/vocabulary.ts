/**
 * The closed vocabularies the abstractor abstracts *against*.
 *
 * Architecture §11.3 makes the last row of its table the safety property:
 *
 *   > Any token outside a closed ~2,000-word common vocabulary  ->  <OOV>
 *   > That last row is the one that matters. Anything distinctive enough to
 *   > identify a child — an unusual name, a rare phrasing, a specific detail —
 *   > is destroyed by construction, not by a redaction pass that might miss
 *   > something.
 *
 * So this file is not a convenience list. **Every word in `BASE` is a word that
 * can survive into the training store**, and the store is read by humans who are
 * not the child's parents. Adding a word here is a privacy decision. The bar:
 * would this word, in a shape, narrow the field of children who could have
 * typed it? If yes, it does not go in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLASSIFIED LISTS ARE SEPARATE, AND DISJOINT
 *
 * EMOTIONS, PETS, PLACES and NAMES are consulted BEFORE `COMMON`, so a word in
 * both would silently never survive — and a reader checking "can this word
 * reach the store?" against COMMON would get the wrong answer. `abstractor.test.ts`
 * asserts the four lists share no member with COMMON. One question, one place
 * to look.
 *
 * WHY ORDINARY WORDS SIT IN `NAMES`
 *
 * `rose`, `grace`, `max`, `jack`, `hope`, `mark`, `sunny` are ordinary English
 * and also seven children. They are in NAMES, which means a child who types
 * "i hope so" gets `i <NAME> so`. That is over-abstraction, and it is the
 * direction this function is allowed to fail in: a lost shape costs a training
 * signal, a kept name costs a child.
 *
 * The exception is words whose grammar role dominates so completely that losing
 * them would wreck every shape — `will`, `may`, `march`, `august`, `art`. Those
 * stay in COMMON, and the honest reason is that they are not distinctive: a
 * shape containing "will" is produced by millions of turns, so it identifies
 * nobody, and the k-anonymity floor of 25 handles what abstraction cannot.
 *
 * WHY INFLECTIONS ARE GENERATED
 *
 * `BASE` holds lemmas, because a hand-written list with `mum` but not `mums`
 * turns an ordinary possessive into `<OOV>` and makes shapes unreadable. The
 * forms are derived by rule at module load, so the authored file stays a list a
 * person can review — which is the whole reason `safety-kernel` is pure.
 */

/** Plural, third-person, past and progressive forms, by the boring rules. */
function inflect(base: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of base) {
    if (w.length < 3) continue;
    const last = w.at(-1)!;
    const last2 = w.slice(-2);
    if (last === 'y' && !'aeiou'.includes(w.at(-2)!)) {
      out.push(`${w.slice(0, -1)}ies`, `${w.slice(0, -1)}ied`);
    } else if (last === 's' || last === 'x' || last === 'z'
      || last2 === 'ch' || last2 === 'sh') {
      out.push(`${w}es`, `${w}ed`);
    } else {
      out.push(`${w}s`, last === 'e' ? `${w}d` : `${w}ed`);
    }
    out.push(last === 'e' ? `${w.slice(0, -1)}ing` : `${w}ing`);
  }
  return out;
}

const all = (base: readonly string[]): ReadonlySet<string> =>
  new Set([...base, ...inflect(base)]);

// ---------------------------------------------------------------------------
// EMOTIONS — checked first, because "sad" is the most useful token in a shape
// and the least useful word to keep literally.
// ---------------------------------------------------------------------------

const EMOTION_BASE = [
  'afraid', 'alone', 'angry', 'annoyed', 'anxious', 'ashamed', 'awful',
  'bored', 'brave', 'broken', 'calm', 'cheerful', 'confident',
  'confused', 'delighted', 'depressed', 'desperate', 'disappointed',
  'discouraged', 'disgusted', 'distressed', 'embarrassed', 'empty',
  'excited', 'exhausted', 'fed-up', 'frightened', 'frustrated', 'furious',
  'glad', 'gloomy', 'grateful', 'grief', 'guilty', 'happy', 'hate', 'heartbroken',
  'helpless', 'homesick', 'hopeless', 'hurt', 'ignored', 'insecure', 'jealous',
  'joyful', 'left-out', 'lonely', 'lost', 'love', 'mad', 'miserable', 'nervous',
  'numb', 'overwhelmed', 'panicky', 'peaceful', 'proud', 'relaxed', 'relieved',
  'restless', 'sad', 'scared', 'shaky', 'shy', 'sorry', 'stressed', 'tearful',
  'tense', 'terrified', 'thrilled', 'tired', 'trapped', 'unhappy', 'unloved',
  'unsafe', 'unwanted', 'upset', 'useless', 'weird', 'worried', 'worry',
  'worthless',
];

export const EMOTIONS = all(EMOTION_BASE);

/**
 * Emotions children spell across two or three words. Matched LONGEST FIRST and
 * before single words, so "empty inside" is one `<EMOTION>` rather than an
 * `<EMOTION>` with a stray preposition — which is what the worked example in
 * architecture §11.3 requires.
 */
export const EMOTION_PHRASES: readonly string[] = Object.freeze([
  'empty inside', 'fed up', 'left out', 'let down', 'on edge', 'shut down',
  'sick of it', 'so done', 'worn out', 'a bit down', 'not ok', 'not okay',
  'not myself', 'in a mood', 'over it', 'done with it', 'sick and tired',
  'want to cry', 'like crying', 'like screaming', 'out of it',
]);

// ---------------------------------------------------------------------------
// PETS — animals a child owns and names. Not every animal: `lion` and `tiger`
// are in COMMON, because "i like tigers" is a fact about a zoo, not a household.
// ---------------------------------------------------------------------------

const PET_BASE = [
  'alsatian', 'beagle', 'budgie', 'bulldog', 'bunny', 'canary', 'cat', 'chick',
  'chihuahua', 'cockatiel', 'corgi', 'dachshund', 'dalmatian', 'dog', 'doggy',
  'ferret', 'gerbil', 'goldfish', 'guineapig', 'guppy', 'hamster',
  'kitten', 'kitty', 'labrador', 'lovebird', 'mongrel', 'parakeet', 'parrot',
  'pet', 'pomeranian', 'poodle', 'pug', 'puppy', 'rabbit', 'retriever',
  'rottweiler', 'spaniel', 'terrier', 'tortoise', 'turtle',
];

export const PETS = all(PET_BASE);

// ---------------------------------------------------------------------------
// PLACES — place NOUNS and the handful of place names common enough to be
// non-identifying. This list is deliberately short: a town small enough to
// narrow the field is a town that belongs in <OOV>, and the cue rules in
// `abstractor.ts` catch the ones a list never could.
// ---------------------------------------------------------------------------

const PLACE_BASE = [
  'africa', 'america', 'asia', 'australia', 'bangalore', 'bengaluru', 'britain',
  'canada', 'chennai', 'china', 'delhi', 'dubai', 'england', 'europe', 'france',
  'germany', 'hyderabad', 'india', 'ireland', 'italy', 'japan', 'kerala',
  'kolkata', 'london', 'madras', 'madurai', 'manchester', 'mumbai', 'nepal',
  'newyork', 'pakistan', 'russia', 'scotland', 'singapore', 'spain', 'srilanka',
  'sydney', 'tamilnadu', 'wales',
];

export const PLACES = all(PLACE_BASE);

// ---------------------------------------------------------------------------
// NAMES — given names and the pet names children reuse. Not a census: it is the
// set of words the abstractor should treat as a name EVEN THOUGH they are also
// ordinary English, plus enough common given names that the commonest turn in
// the product ("my name is …") collapses.
// ---------------------------------------------------------------------------

const NAME_BASE = [
  // ordinary words that are also children
  'amber', 'angel', 'anna', 'april-no', 'bill', 'blossom', 'brook',
  'buddy', 'cherry', 'daisy', 'dawn', 'faith', 'grace', 'harmony',
  'heather', 'holly', 'honey', 'hope', 'hunter', 'iris', 'ivy', 'jack',
  'jasmine', 'jazz', 'joy', 'lily', 'lucky', 'mark', 'max', 'melody', 'olive',
  'pearl', 'pepper', 'poppy', 'reed', 'rose', 'ruby', 'rusty', 'sage', 'sandy',
  'sky-no', 'snowy', 'sunny', 'violet', 'willow',
  // common given names, India and the diaspora
  'aadhya', 'aanya', 'aarav', 'aarti', 'abhi', 'aditi', 'aditya', 'advait',
  'akash', 'akshay', 'amit', 'ananya', 'anil', 'anjali', 'ankit', 'anu',
  'anusha', 'arjun', 'arun', 'ashwin', 'avni', 'ayaan', 'bala', 'bhavya',
  'chandra', 'darshan', 'deepa', 'deepak', 'dev', 'devi', 'dhruv', 'divya',
  'gauri', 'gautam', 'gopal', 'harini', 'harsh', 'ishaan', 'ishita', 'jaya',
  'kabir', 'kalpana', 'kamal', 'kannan', 'karan', 'karthik', 'kavya', 'keerthi',
  'krishna', 'lakshmi', 'lalitha', 'madhav', 'mahesh', 'malini', 'manav',
  'manju', 'meena', 'meera', 'mohan', 'mukesh', 'nandini', 'naveen', 'neha',
  'nikhil', 'nisha', 'nithya', 'pooja', 'prakash', 'pranav', 'preethi', 'priya',
  'radha', 'raghu', 'rahul', 'raj', 'rajesh', 'raman', 'ramesh', 'ravi', 'reva',
  'riya', 'rohan', 'rohit', 'sahana', 'sai', 'sanjay', 'sanjana', 'saran',
  'sathish', 'selva', 'shalini', 'shanti', 'sharma', 'shreya', 'shruti',
  'siddharth', 'sneha', 'sowmya', 'srinivas', 'subha', 'sudha', 'suman',
  'sunil', 'suresh', 'swati', 'tanvi', 'tara', 'usha', 'varun', 'veena',
  'vidya', 'vijay', 'vikram', 'vinay', 'vishnu', 'yash',
  // common given names, elsewhere
  'aisha', 'alex', 'alice', 'amelia', 'ana', 'andrew', 'ben', 'bo', 'charlie',
  'chloe', 'chris', 'daniel', 'david', 'ella', 'emily', 'emma', 'ethan',
  'fatima', 'freya', 'george', 'hannah', 'harry', 'isabella', 'james', 'jamie',
  'jane', 'jessica', 'john', 'jose', 'joseph', 'josh', 'julia', 'kate', 'kevin',
  'leo', 'liam', 'lucas', 'lucy', 'maria', 'mary', 'mia', 'michael', 'mohammed',
  'nathan', 'noah', 'oliver', 'olivia', 'omar', 'oscar', 'paul', 'peter',
  'ruth', 'ryan', 'sam', 'sara', 'sarah', 'sofia', 'sophie', 'thomas', 'tom',
  'william', 'yusuf', 'zara', 'zoe',
];

export const NAMES = all(NAME_BASE.filter((n) => !n.endsWith('-no')));

// ---------------------------------------------------------------------------
// COMMON — the ~2,000 lemmas of architecture §11.3.
// ---------------------------------------------------------------------------

const COMMON_BASE = [
  // --- grammar: the words that make a shape readable at all ----------------
  'a', 'about', 'above', 'across', 'after', 'again', 'against', 'ago', 'all',
  'almost', 'along', 'already', 'also', 'although', 'always', 'am', 'among',
  'an', 'and', 'another', 'any', 'anymore', 'anyone', 'anything', 'anyway',
  'anywhere', 'are', 'arent', 'around', 'as', 'at', 'away', 'back', 'be',
  'because', 'been', 'before', 'behind', 'being', 'below', 'beside', 'best',
  'better', 'between', 'both', 'but', 'by', 'came', 'can', 'cannot', 'cant',
  'could', 'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'done',
  'dont', 'down', 'during', 'each', 'either', 'else', 'enough', 'even', 'ever',
  'every', 'everybody', 'everyone', 'everything', 'everywhere', 'except', 'far',
  'few', 'for', 'from', 'further', 'gonna', 'gotta', 'had', 'hadnt', 'has',
  'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'her', 'hers',
  'herself', 'hes', 'him', 'himself', 'his', 'how', 'however', 'i', 'id', 'if',
  'ill', 'im', 'in', 'instead', 'into', 'is', 'isnt', 'it', 'its', 'itself',
  'ive', 'just', 'least', 'less', 'let', 'lets', 'like', 'many', 'may', 'maybe',
  'me', 'might', 'mine', 'more', 'most', 'much', 'must', 'my', 'myself',
  'nearly', 'need', 'neither', 'never', 'no', 'nobody', 'none', 'nor', 'not',
  'nothing', 'now', 'of', 'off', 'often', 'oh', 'ok', 'okay', 'on', 'once',
  'one', 'only', 'onto', 'or', 'other', 'ought', 'our', 'ours', 'ourselves',
  'out', 'over', 'own', 'per', 'please', 'quite', 'rather', 'really', 'said',
  'same', 'say', 'see', 'seem', 'shall', 'she', 'shes', 'should', 'shouldnt',
  'since', 'so', 'some', 'somebody', 'someone', 'something', 'sometimes',
  'somewhere', 'soon', 'still', 'such', 'sure', 'than', 'that', 'thats', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'therefore',
  'these', 'they', 'theyre', 'theyve', 'thing', 'this', 'those', 'though',
  'through', 'to', 'together', 'too', 'towards', 'twice', 'under', 'until',
  'up', 'upon', 'us', 'very', 'was', 'wasnt', 'we', 'well', 'went', 'were',
  'werent', 'weve', 'what', 'whatever', 'when', 'whenever', 'where', 'whether',
  'which', 'while', 'who', 'whoever', 'whom', 'whose', 'why', 'will', 'with',
  'within', 'without', 'wont', 'would', 'wouldnt', 'yeah', 'yep', 'yes', 'yet',
  'you', 'youd', 'youll', 'your', 'yours', 'yourself', 'youre', 'youve',

  // --- verbs ---------------------------------------------------------------
  'accept', 'ache', 'act', 'add', 'agree', 'allow', 'answer', 'apologise',
  'appear', 'argue', 'arrive', 'ask', 'bake', 'bark', 'become', 'begin', 'behave',
  'believe', 'belong', 'bite', 'blow', 'boil', 'borrow', 'bounce', 'break',
  'breathe', 'bring', 'brush', 'build', 'burn', 'burst', 'buy', 'calculate',
  'call', 'care', 'carry', 'catch', 'change', 'chase', 'chat', 'cheat', 'check',
  'cheer', 'chew', 'choose', 'clap', 'clean', 'clear', 'click', 'climb',
  'close', 'collect', 'colour', 'come', 'compare', 'complain', 'complete',
  'connect', 'consider', 'contain', 'continue', 'cook', 'copy', 'cost', 'count',
  'cover', 'crash', 'crawl', 'create', 'cross', 'cry', 'cut', 'dance', 'decide',
  'describe', 'die', 'dig', 'discover', 'discuss', 'divide', 'draw', 'dream',
  'dress', 'drink', 'drive', 'drop', 'dry', 'earn', 'eat', 'end', 'enjoy',
  'enter', 'escape', 'exercise', 'exist', 'expect', 'explain', 'explore',
  'fail', 'fall', 'feed', 'feel', 'fight', 'fill', 'find', 'finish', 'fit',
  'fix', 'float', 'fly', 'fold', 'follow', 'forget', 'forgive', 'freeze',
  'get', 'give', 'go', 'grab', 'greet', 'grow', 'guess', 'hang', 'happen',
  'hear', 'help', 'hide', 'hit', 'hold', 'hug', 'hurry', 'imagine', 'improve',
  'include', 'invite', 'join', 'joke', 'jump', 'keep', 'kick', 'kill', 'kiss',
  'knock', 'know', 'land', 'last', 'laugh', 'lay', 'lead', 'lean', 'learn',
  'leave', 'lend', 'lie', 'lift', 'listen', 'live', 'lock', 'look', 'lose',
  'make', 'march', 'match', 'matter', 'mean', 'measure', 'meet', 'melt',
  'mention', 'mind', 'miss', 'mix', 'move', 'name', 'notice', 'obey', 'offer',
  'open', 'order', 'pack', 'paint', 'pass', 'pay', 'pick', 'plan', 'plant',
  'play', 'point', 'pour', 'practise', 'pray', 'prefer', 'prepare', 'press',
  'pretend', 'promise', 'pull', 'push', 'put', 'raise', 'reach', 'read',
  'realise', 'receive', 'record', 'reduce', 'remember', 'remind', 'remove',
  'repair', 'repeat', 'reply', 'rest', 'return', 'revise', 'ride', 'ring',
  'rise', 'roll', 'run', 'save', 'scream', 'search', 'seat', 'sell', 'send',
  'set', 'settle', 'shake', 'share', 'shine', 'shout', 'show', 'shut', 'sing',
  'sink', 'sit', 'skip', 'sleep', 'slide', 'slip', 'smell', 'smile', 'snow',
  'solve', 'sort', 'sound', 'speak', 'spell', 'spend', 'spill', 'spin',
  'stand', 'stare', 'start', 'stay', 'steal', 'stick', 'stop', 'stretch',
  'study', 'subtract', 'succeed', 'suggest', 'support', 'suppose', 'swim',
  'swing', 'take', 'talk', 'taste', 'teach', 'tease', 'tell', 'thank', 'think',
  'throw', 'tidy', 'tie', 'touch', 'train', 'travel', 'treat', 'trick', 'trip',
  'trust', 'try', 'turn', 'understand', 'use', 'visit', 'wait', 'wake', 'walk',
  'wander', 'want', 'warn', 'wash', 'watch', 'wave', 'wear', 'weigh', 'welcome',
  'win', 'wipe', 'wish', 'wonder', 'work', 'wrap', 'write', 'yell',

  // --- irregular pasts, which no suffix rule generates ----------------------
  // `inflect` turns `walk` into `walked` and has nothing to say about `went`.
  // Without these, half the verbs a child uses in the past tense arrive as
  // <OOV> — destroying ordinary words and buying no privacy at all.
  // Omitted on purpose: `rose` (NAMES), `lost` and `hurt` (EMOTIONS).
  'ate', 'became', 'began', 'bit', 'blew', 'bought', 'broke', 'brought',
  'built', 'burnt', 'caught', 'chose', 'dug', 'drank', 'drew', 'drove', 'fed',
  'fell', 'felt', 'fought', 'flew', 'forgot', 'forgave', 'found', 'froze',
  'gave', 'got', 'grew', 'heard', 'held', 'hid', 'kept', 'knew', 'laid', 'led',
  'lent', 'made', 'meant', 'met', 'paid', 'ran', 'rang', 'rode', 'said', 'sang',
  'sank', 'sat', 'saw', 'sold', 'sent', 'shone', 'shook', 'shot', 'showed',
  'shut', 'slept', 'slid', 'spent', 'spoke', 'spun', 'stole', 'stood', 'stuck',
  'swam', 'taught', 'thought', 'threw', 'told', 'took', 'tore', 'understood',
  'woke', 'wept', 'won', 'wore', 'wrote',

  // --- people, home, family ------------------------------------------------
  'adult', 'amma', 'appa', 'aunt', 'auntie', 'baby', 'boy', 'brother', 'child',
  'children', 'class', 'classmate', 'club', 'cousin', 'dad', 'daddy',
  'daughter', 'family', 'father', 'friend', 'friendship', 'girl', 'grandad',
  'grandchild', 'granddad', 'grandma', 'grandmother', 'grandpa',
  'grandfather', 'group', 'guest', 'kid', 'lady', 'man', 'mate', 'men', 'mother',
  'mum', 'mummy', 'neighbour', 'nephew', 'niece', 'parent', 'partner', 'people',
  'person', 'sibling', 'sister', 'son', 'stranger', 'teenager', 'twin', 'uncle',
  'woman', 'women',

  // --- house and objects ---------------------------------------------------
  'address', 'apartment', 'attic', 'bag', 'balcony', 'ball', 'balloon', 'basket',
  'bath', 'bathroom', 'battery', 'bed', 'bedroom', 'bell', 'bench', 'bicycle',
  'bike', 'blanket', 'board', 'boat', 'book', 'boot', 'bottle', 'bowl', 'box',
  'brick', 'broom', 'brush', 'bucket', 'building', 'bulb', 'bus', 'button',
  'cable', 'camera', 'candle', 'cap', 'car', 'card', 'carpet', 'ceiling',
  'chain', 'chair', 'chalk', 'charger', 'clock', 'cloth', 'clothes', 'coat',
  'coin', 'comb', 'computer', 'cooker', 'cot', 'crayon', 'cup', 'cupboard',
  'curtain', 'cushion', 'desk', 'diary', 'dish', 'doll', 'door', 'drawer',
  'dress', 'drum', 'engine', 'envelope', 'eraser', 'fan', 'fence', 'file',
  'floor', 'flute', 'fork', 'frame', 'fridge', 'furniture', 'game', 'garage',
  'gate', 'gift', 'glass', 'glasses', 'glue', 'gold', 'guitar', 'gun', 'hammer',
  'handle', 'hat', 'headphone', 'helmet', 'hole', 'home', 'hook', 'house',
  'jacket', 'jar', 'jeans', 'jewel', 'jug', 'kettle', 'key', 'keyboard',
  'kitchen', 'kite', 'knife', 'ladder', 'lamp', 'laptop', 'lid', 'light',
  'lock', 'lorry', 'machine', 'mat', 'match', 'mirror', 'mobile', 'money',
  'motorbike', 'nail', 'necklace', 'needle', 'note', 'notebook', 'oven',
  'page', 'pan', 'paper', 'pen', 'pencil', 'phone', 'photo', 'piano',
  'picture', 'pillow', 'pin', 'pipe', 'plane', 'plate', 'plug', 'pocket',
  'poster', 'pot', 'purse', 'puzzle', 'radio', 'rail', 'ribbon', 'ring',
  'robot', 'rocket', 'roof', 'room', 'rope', 'rubber', 'rug', 'ruler',
  'scissors', 'screen', 'sheet', 'shelf', 'ship', 'shirt', 'shoe', 'shorts',
  'skirt', 'soap', 'sock', 'sofa', 'speaker', 'spoon', 'stair', 'stamp',
  'stick', 'stone', 'string', 'sweater', 'switch', 'table', 'tablet', 'tap',
  'tape', 'television', 'tent', 'ticket', 'tie', 'toilet', 'tool', 'toothbrush',
  'torch', 'towel', 'toy', 'train', 'trousers', 'truck', 'tshirt', 'tube',
  'tyre', 'umbrella', 'uniform', 'van', 'vase', 'wall', 'wallet', 'wardrobe',
  'watch', 'wheel', 'whistle', 'window', 'wire', 'wood', 'wool', 'yard', 'zip',

  // --- food ----------------------------------------------------------------
  'apple', 'banana', 'biscuit', 'biryani', 'bread', 'breakfast', 'butter',
  'cake', 'candy', 'carrot', 'cereal', 'chapati', 'cheese', 'chicken', 'chilli',
  'chips', 'chocolate', 'coconut', 'coffee', 'cookie', 'cream', 'cucumber',
  'curd', 'curry', 'dessert', 'dinner', 'dosa', 'drink', 'egg', 'fish', 'flour',
  'food', 'fruit', 'garlic', 'ginger', 'grape', 'honey-no', 'ice', 'icecream',
  'idli', 'jam', 'juice', 'ladoo', 'lemon', 'lunch', 'mango', 'masala', 'meal',
  'meat', 'milk', 'noodle', 'nut', 'oil', 'onion', 'orange', 'pasta', 'pea',
  'peanut', 'pizza', 'popcorn', 'potato', 'pudding', 'rasam', 'rice', 'roti',
  'salad', 'salt', 'sambar', 'samosa', 'sandwich', 'sauce', 'snack', 'soup',
  'spice', 'sugar', 'supper', 'sweet', 'tea', 'toast', 'tomato', 'vegetable',
  'water', 'wheat', 'yoghurt',

  // --- body and health -----------------------------------------------------
  'arm', 'back', 'blood', 'body', 'bone', 'brain', 'cheek', 'chest', 'chin',
  'cold', 'cough', 'ear', 'elbow', 'eye', 'face', 'finger', 'foot', 'hair',
  'hand', 'head', 'headache', 'health', 'heart', 'heel', 'hip', 'knee', 'leg',
  'lip', 'lung', 'medicine', 'mouth', 'muscle', 'nail', 'neck', 'nose',
  'nurse', 'pain', 'shoulder', 'sick', 'skin', 'sleep', 'stomach',
  'stomachache', 'temperature', 'thumb', 'toe', 'tongue', 'tooth', 'teeth',
  'toothache', 'tummy', 'voice', 'waist', 'wrist',

  // --- school and learning -------------------------------------------------
  'absent', 'activity', 'addition', 'algebra', 'alphabet', 'angle', 'answer',
  'art', 'assembly', 'assignment', 'atom', 'average', 'bag', 'bell', 'biology',
  'blackboard', 'board', 'book', 'break', 'bully', 'calculator', 'capital',
  'cell', 'century', 'chapter', 'chart', 'chemistry', 'circle', 'classroom',
  'colon', 'comma', 'comprehension', 'computer', 'continent', 'course',
  'curriculum', 'decimal', 'degree', 'denominator', 'detention', 'diagram',
  'dictionary', 'difference', 'digit', 'distance', 'division', 'drawing',
  'education', 'energy', 'english', 'equal', 'equation', 'essay', 'exam',
  'example', 'exercise', 'experiment', 'fact', 'factor', 'force', 'formula',
  'fraction', 'french', 'geography', 'geometry', 'grade', 'grammar', 'gram',
  'gravity', 'greater', 'half', 'handwriting', 'hindi', 'history', 'homework',
  'hour', 'idea', 'index', 'integer', 'kilogram', 'kilometre', 'knowledge',
  'lab', 'language', 'lesson', 'letter', 'library', 'line', 'liquid', 'list',
  'litre', 'magnet', 'mark-no', 'mass', 'maths', 'mathematics', 'matter',
  'metre', 'minus', 'mistake', 'mixture', 'molecule', 'multiply', 'nature',
  'noun', 'number', 'numerator', 'orbit', 'paragraph', 'parallel', 'pattern',
  'percent', 'perimeter', 'physics', 'plural', 'plus', 'poem', 'poetry',
  'positive', 'practice', 'prime', 'principal', 'problem', 'product',
  'project', 'pronoun', 'punctuation', 'question', 'quiz', 'quotient',
  'radius', 'reading', 'rectangle', 'remainder', 'revision', 'rule', 'science',
  'sentence', 'sequence', 'shape', 'singular', 'solid', 'solution', 'spelling',
  'sport', 'square', 'stem', 'story', 'student', 'subject', 'subtraction',
  'sum', 'summary', 'syllable', 'symbol', 'tamil', 'teacher', 'team', 'term',
  'test', 'text', 'theory', 'timetable', 'title', 'topic', 'total', 'triangle',
  'uniform', 'unit', 'value', 'verb', 'vocabulary', 'volume', 'weight',
  'width', 'word', 'worksheet', 'writing', 'zero',

  // --- world, nature, weather ----------------------------------------------
  'air', 'animal', 'ant', 'autumn', 'beach', 'bear', 'bee', 'bird', 'branch',
  'bridge', 'bush', 'butterfly', 'city', 'cloud', 'coast', 'country',
  'countryside', 'cow', 'crocodile', 'crow', 'deer', 'desert', 'dolphin',
  'donkey', 'dragon', 'duck', 'dust', 'eagle', 'earth', 'elephant', 'farm',
  'farmer', 'feather', 'field', 'fire', 'flood', 'flower', 'fog', 'forest',
  'fox', 'frog', 'garden', 'giraffe', 'goat', 'grass', 'ground', 'hen',
  'hill', 'horse', 'insect', 'island', 'jungle', 'lake', 'leaf', 'leaves',
  'lightning', 'lion', 'monkey', 'moon', 'mosquito', 'mountain', 'mouse',
  'mud', 'nest', 'ocean', 'owl', 'ox', 'park', 'peacock', 'pig', 'planet',
  'plant', 'pond', 'rain', 'rainbow', 'rat', 'river', 'road', 'rock', 'root',
  'sand', 'sea', 'season', 'seed', 'shadow', 'shark', 'sheep', 'sky', 'snail', 'snake',
  'soil', 'space', 'spider', 'spring', 'squirrel', 'star', 'storm', 'stream',
  'street', 'summer', 'sun', 'sunlight', 'sunshine', 'swan', 'thunder',
  'tiger', 'tree', 'valley', 'village', 'weather', 'whale', 'wind', 'wing',
  'winter', 'wolf', 'wood', 'world', 'worm', 'zebra', 'zoo',

  // --- places a child goes -------------------------------------------------
  'airport', 'bank', 'cafe', 'cinema', 'church', 'clinic', 'college',
  'exhibition', 'flat', 'ground', 'gym', 'hall', 'hospital', 'hotel', 'market',
  'mosque', 'museum', 'office', 'playground', 'pool', 'restaurant', 'school',
  'shop', 'station', 'store', 'temple', 'theatre', 'town', 'zoo',

  // --- time ----------------------------------------------------------------
  'afternoon', 'april', 'august', 'birthday', 'christmas', 'daily', 'date',
  'day', 'december', 'diwali', 'evening', 'february', 'friday', 'future',
  'holiday', 'january', 'july', 'june', 'midnight', 'minute', 'moment',
  'monday', 'month', 'morning', 'night', 'noon', 'november', 'october',
  'pongal', 'saturday', 'second', 'september', 'sunday', 'thursday', 'time',
  'today', 'tomorrow', 'tonight', 'tuesday', 'wednesday', 'week', 'weekend',
  'year', 'yesterday',

  // --- numbers spelled out -------------------------------------------------
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty',
  'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand',
  'million', 'billion', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth',
  'seventh', 'eighth', 'ninth', 'tenth', 'once', 'double', 'triple', 'pair',
  'dozen', 'couple', 'lot', 'plenty', 'several',

  // --- adjectives ----------------------------------------------------------
  'able', 'active', 'actual', 'alive', 'available', 'awake', 'aware', 'bad',
  'beautiful', 'big', 'bitter', 'black', 'blank', 'blue', 'boring', 'bright',
  'brown', 'busy', 'careful', 'certain', 'cheap', 'clean', 'clever', 'clumsy',
  'cold', 'colourful', 'common', 'complicated', 'cool', 'correct', 'cosy',
  'crazy', 'cruel', 'cute', 'dangerous', 'dark', 'dead', 'deep', 'delicious',
  'different', 'difficult', 'dirty', 'dry', 'dull', 'early', 'easy', 'electric',
  'expensive', 'extra', 'fair', 'false', 'famous', 'fantastic', 'fast', 'fat',
  'favourite', 'final', 'fine', 'flat', 'free', 'fresh', 'friendly', 'full',
  'funny', 'gentle', 'giant', 'golden', 'good', 'great', 'green', 'grey',
  'hard', 'harmless', 'healthy', 'heavy', 'high', 'honest', 'hot', 'huge',
  'hungry', 'ill', 'important', 'impossible', 'interesting', 'kind', 'large',
  'late', 'lazy', 'left', 'light', 'little', 'long', 'loud', 'lovely', 'low',
  'lucky-no', 'magic', 'main', 'modern', 'narrow', 'nasty', 'natural',
  'naughty', 'near', 'neat', 'new', 'next', 'nice', 'noisy', 'normal', 'odd',
  'old', 'open', 'opposite', 'ordinary', 'orange', 'original', 'pale',
  'perfect', 'pink', 'polite', 'poor', 'popular', 'possible', 'pretty',
  'public', 'purple', 'quick', 'quiet', 'rare', 'raw', 'ready', 'real',
  'red', 'rich', 'right', 'ripe', 'round', 'rough', 'rude', 'safe', 'salty',
  'secret', 'serious', 'sharp', 'short', 'silly', 'silver', 'similar',
  'simple', 'slow', 'small', 'smart', 'smooth', 'soft', 'sour', 'special',
  'spicy', 'straight', 'strange', 'strong', 'stupid', 'sudden', 'super',
  'sweet', 'tall', 'tasty', 'terrible', 'thick', 'thin', 'thirsty', 'tidy',
  'tiny', 'tough', 'true', 'ugly', 'unfair', 'unkind', 'useful', 'usual',
  'warm', 'weak', 'wet', 'white', 'whole', 'wide', 'wild', 'wonderful',
  'wooden', 'wrong', 'yellow', 'young',

  // --- adverbs and connectives ---------------------------------------------
  'absolutely', 'accidentally', 'actually', 'almost', 'aloud',
  'apparently', 'badly', 'barely', 'basically', 'carefully', 'certainly',
  'clearly', 'completely', 'definitely', 'easily', 'especially', 'eventually',
  'exactly', 'finally', 'forever', 'fully', 'generally', 'gently', 'hardly',
  'honestly', 'immediately', 'kindly', 'lately', 'loudly', 'luckily', 'mainly',
  'mostly', 'nearly', 'nowadays', 'obviously', 'others', 'otherwise',
  'particularly', 'perfectly', 'perhaps', 'possibly', 'probably', 'properly',
  'quickly', 'quietly', 'rarely', 'recently', 'seldom', 'seriously', 'simply',
  'slightly', 'slowly', 'straightaway', 'strongly', 'suddenly', 'totally',
  'truly', 'unfortunately', 'usually', 'wisely',

  // --- product, screen, and the words a child uses about Chittu ------------
  'account', 'app', 'chat', 'chittu', 'click', 'data', 'device', 'download',
  'email', 'emoji', 'game', 'icon', 'internet', 'level', 'link', 'login',
  'message', 'online', 'password', 'playlist', 'post', 'profile', 'reply',
  'robot', 'scroll', 'search', 'setting', 'site', 'song', 'sound', 'speaker',
  'story', 'stream', 'swipe', 'tap', 'text', 'upload', 'user', 'video',
  'voice', 'volume', 'web', 'website', 'wifi',

  // --- greetings and noises ------------------------------------------------
  'bye', 'goodbye', 'goodnight', 'haha', 'hello', 'help', 'hey', 'hi', 'hmm',
  'lol', 'nope', 'oops', 'sorry-no', 'thanks', 'thankyou', 'welcome', 'wow',

  // --- everything else a child says a lot ----------------------------------
  'accident', 'advice', 'age', 'ambition', 'amount', 'area', 'argument',
  'attention', 'behaviour', 'birthday', 'chance', 'change', 'choice', 'colour',
  'competition', 'cost', 'crowd', 'dance', 'danger', 'decision', 'detail',
  'direction', 'dream', 'effort', 'end', 'event', 'excuse', 'exit', 'fault',
  'favour', 'festival', 'film', 'fun', 'goal', 'habit', 'hobby', 'idea',
  'information', 'interest', 'job', 'joke', 'journey', 'life', 'luck', 'match',
  'meaning', 'meeting', 'memory', 'method', 'movie', 'music', 'news', 'noise',
  'opinion', 'order', 'party', 'past', 'peace', 'permission', 'piece', 'place',
  'plan', 'play', 'point', 'position', 'power', 'practice', 'present', 'price',
  'prize', 'promise', 'purpose', 'quarrel', 'race', 'reason', 'recipe',
  'record', 'religion', 'report', 'rest', 'result', 'reward', 'risk', 'rule',
  'safety', 'secret', 'shame', 'side', 'sign', 'silence', 'size', 'skill',
  'sound', 'speed', 'sport', 'start', 'step', 'style', 'success', 'surprise',
  'system', 'talent', 'task', 'thought', 'trick', 'trip', 'trouble', 'truth',
  'turn', 'type', 'use', 'view', 'visit', 'war', 'way', 'wish', 'work', 'world',
  // "6 x 8" is arithmetic. Without this the whole turn collapses to `<NUM>` and
  // stops being recognisable as a maths shape at all.
  'x',
];

/**
 * Lemmas as authored — what §11.3 means by "a closed ~2,000-word vocabulary".
 *
 * A `-no` suffix marks a word deliberately withheld at the point a reader would
 * expect to find it: `sorry-no` sits in the greetings block so nobody adds it
 * back without seeing that it lives in EMOTIONS, and `mark-no` likewise for
 * NAMES.
 */
export const BASE: ReadonlySet<string> = Object.freeze(
  new Set(COMMON_BASE.filter((w) => !w.endsWith('-no'))));

/**
 * Lemmas plus their derived forms, MINUS anything a classified list claims.
 *
 * The subtraction is not tidiness. `inflect` is a set of boring suffix rules
 * that cannot tell a noun from a verb, so `hat` generates `hated` and `hating`
 * — which are `hate`'s forms, and `hate` is an emotion. Left alone, the
 * commonest word for the strongest feeling in the file would have survived
 * literally into the store because a child mentioned a hat.
 *
 * Subtracting here rather than relying on the order of checks in
 * `abstractor.ts` makes that order unobservable, which is what the comment on
 * `classify()` claims. `abstractor.test.ts` asserts the AUTHORED lists have no
 * word in common, because that is the mistake a person makes; this handles the
 * mistake a suffix rule makes.
 */
const CLASSIFIED: ReadonlySet<string> = new Set([
  ...EMOTIONS, ...PETS, ...PLACES, ...NAMES]);

export const COMMON: ReadonlySet<string> = Object.freeze(
  new Set([...all([...BASE])].filter((w) => !CLASSIFIED.has(w))));

/**
 * The lemmas exactly as a human wrote them, for the test that asks whether a
 * human wrote the same word in two lists. Derived forms are excluded on
 * purpose: a collision between two GENERATED forms is handled above and is not
 * an authoring error.
 */
export const AUTHORED = Object.freeze({
  common: Object.freeze([...BASE]),
  emotions: Object.freeze(EMOTION_BASE.filter((w) => !w.endsWith('-no'))),
  pets: Object.freeze(PET_BASE),
  places: Object.freeze(PLACE_BASE),
  names: Object.freeze(NAME_BASE.filter((n) => !n.endsWith('-no'))),
});
