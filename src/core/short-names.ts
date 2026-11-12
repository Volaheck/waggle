/**
 * The usual short forms of first names («Саша» for Александр, «Женя» for Евгений), with the Latin spellings people
 * write those names in: «напомни Саше» then finds a member called Alexander, and «Жене» one called Евгений. Only a
 * request to remind someone uses them (src/bot/reminders.ts), to check whom a reading picked against the name it was
 * given.
 */
const SHORT_FORMS: [full: string[], short: string[]][] = [
  [["александр", "alexander", "aleksandr", "alexandr"], ["саша", "шура", "саня", "санек", "sasha", "sanya", "alex"]],
  [["александра", "alexandra", "aleksandra"], ["саша", "шура", "саня", "sasha"]],
  [["алексей", "alexey", "aleksey", "alexei", "aleksei"], ["леша", "алеша", "lyosha", "lesha"]],
  [["анастасия", "anastasia", "anastasiya"], ["настя", "nastya"]],
  [["анатолий", "anatoly", "anatoliy"], ["толя", "tolya"]],
  [["андрей", "andrey", "andrei"], ["андрюша", "дрюша"]],
  [["анна", "anna"], ["аня", "анюта", "anya"]],
  [["антон", "anton"], ["тоша", "антоша"]],
  [["артем", "artem", "artyom"], ["тема", "tyoma", "tema"]],
  [["борис", "boris"], ["боря"]],
  [["валентин", "valentin"], ["валя"]],
  [["валентина", "valentina"], ["валя"]],
  [["василий", "vasily", "vasiliy"], ["вася", "vasya"]],
  [["виктор", "viktor", "victor"], ["витя", "vitya"]],
  [["виктория", "viktoria", "victoria"], ["вика", "vika"]],
  [["владимир", "vladimir"], ["вова", "володя", "vova"]],
  [["владислав", "vladislav"], ["влад", "слава", "vlad"]],
  [["вячеслав", "vyacheslav"], ["слава", "slava"]],
  [["георгий", "georgy", "georgiy"], ["гоша", "жора", "gosha"]],
  [["григорий", "grigory", "grigoriy"], ["гриша", "grisha"]],
  [["даниил", "данила", "daniil", "danila"], ["даня", "danya"]],
  [["дарья", "daria", "darya"], ["даша", "dasha"]],
  [["дмитрий", "dmitry", "dmitriy", "dmitri"], ["дима", "митя", "dima"]],
  [["евгений", "evgeny", "evgeniy", "yevgeny", "eugene"], ["женя", "zhenya"]],
  [["евгения", "evgenia", "evgeniya", "eugenia"], ["женя", "zhenya"]],
  [["екатерина", "ekaterina", "yekaterina", "katerina"], ["катя", "katya"]],
  [["елена", "elena", "yelena"], ["лена", "lena"]],
  [["елизавета", "elizaveta"], ["лиза", "liza"]],
  [["иван", "ivan"], ["ваня", "vanya"]],
  [["илья", "ilya", "ilia"], ["илюша"]],
  [["ирина", "irina"], ["ира", "ira"]],
  [["кирилл", "kirill"], ["киря"]],
  [["константин", "konstantin"], ["костя", "kostya"]],
  [["ксения", "ksenia", "kseniya"], ["ксюша", "ksyusha"]],
  [["леонид", "leonid"], ["леня"]],
  [["максим", "maxim", "maksim"], ["макс", "max"]],
  [["мария", "maria", "mariya"], ["маша", "masha"]],
  [["михаил", "mikhail"], ["миша", "misha"]],
  [["надежда", "nadezhda"], ["надя"]],
  [["наталья", "наталия", "natalia", "natalya"], ["наташа", "natasha"]],
  [["николай", "nikolai", "nikolay"], ["коля", "kolya"]],
  [["ольга", "olga"], ["оля", "olya"]],
  [["павел", "pavel"], ["паша", "pasha"]],
  [["петр", "petr", "pyotr"], ["петя"]],
  [["роман", "roman"], ["рома", "roma"]],
  [["руслан", "ruslan"], ["руся", "русик"]],
  [["светлана", "svetlana"], ["света", "sveta"]],
  [["сергей", "sergey", "sergei"], ["сережа", "серега", "seryozha"]],
  [["софья", "софия", "sofia", "sofiya", "sophia"], ["соня", "sonya"]],
  [["станислав", "stanislav"], ["стас", "stas"]],
  [["татьяна", "tatiana", "tatyana"], ["таня", "tanya"]],
  [["федор", "fedor", "fyodor"], ["федя"]],
  [["юлия", "yulia", "julia"], ["юля", "yulya"]],
  [["юрий", "yury", "yuriy", "yuri"], ["юра", "yura"]],
  [["ярослав", "yaroslav"], ["слава", "ярик"]],
];

const letters = (text: string) => text.normalize("NFKC").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}]/gu, "");

/**
 * Whether a word of someone's name is this full name: the same, or one holds the other almost whole, as a styled
 * spelling with a letter swapped for a sign does («Λlexander»).
 */
function isFullName(word: string, full: string): boolean {
  if (word === full) return true;
  const [shorter, longer] = word.length <= full.length ? [word, full] : [full, word];
  return shorter.length >= 6 && shorter.length >= longer.length * 0.8 && longer.includes(shorter);
}

/** The short forms of the first names a member's name and nicknames hold. */
export function shortFormsOf(names: string[]): string[] {
  const words = names.flatMap((name) => name.normalize("NFKC").split(/\s+/)).map(letters).filter((word) => word.length >= 3);
  return [...new Set(SHORT_FORMS.flatMap(([full, short]) => (words.some((word) => full.some((name) => isFullName(word, name))) ? short : [])))];
}
