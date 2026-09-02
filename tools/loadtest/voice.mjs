/**
 * Nomes e mensagens do gerador de carga, na voz do Real Oficial.
 *
 * O run aparece na página pública enquanto acontece, então o chat que ele
 * produz é visto por gente de verdade. "loadtest 3#7 lorem ipsum" repetido dez
 * mil vezes não é neutro: é feio, e faz o produto parecer um brinquedo no
 * exato momento em que ele está provando que não é.
 *
 * Três restrições que moldaram tudo aqui, e nenhuma é estética:
 *
 * 1. **As mensagens passam pelos gates.** A régua de caps (`maxCapsRatio` 0.8)
 *    vale a partir de `minLengthForHeuristics` (12 chars) medidos no *corpo
 *    inteiro* — e o timestamp do fim já garante esse comprimento sozinho. Ou
 *    seja: nenhuma linha pode ser toda maiúscula, por mais curta que pareça.
 *    Cada grito aqui carrega minúsculas suficientes para ficar abaixo de 0.8.
 *    Sem links, e no máximo uma menção. Um relatório cheio de `spam` não mede
 *    capacidade nenhuma, mede o gerador brigando com a sala.
 * 2. **Cada corpo é único.** O gate de duplicata derrubaria mensagens
 *    repetidas, e a variação vem da combinação — não de um contador colado no
 *    fim.
 * 3. **O timestamp continua no corpo.** É como cada *receptor* mede a latência
 *    de entrega fim a fim sem contabilidade extra (`/@(\d+)\|/` em run.mjs).
 *    Fica no fim da linha, onde atrapalha menos a leitura.
 *
 * Determinístico: mesma semente, mesma conversa. Dois runs comparados lado a
 * lado não devem diferir pelo texto que passou por eles.
 */

/** PRNG pequeno e estável (mulberry32) — não precisa ser seguro, precisa ser repetível. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (list, r) => list[Math.floor(r() * list.length)];

/* ------------------------------------------------------------------ */
/* nomes                                                               */
/* ------------------------------------------------------------------ */

const NAME_STEMS = [
  "antonio", "bigdog", "gordola", "claudin", "kuberneto", "muskenson", "realito",
  "tibao", "bichao", "bonitao", "formigao", "bigodao", "mauriciao", "samuela",
  "carioques", "doleta", "dinzo", "muambeiro", "juninho", "zezao", "robertao",
  "cleitin", "matheuzin", "gustavao", "valdiro", "tiaozin", "brunao", "joaozin",
  "paulao", "rafinha", "leozin", "dedeco", "tuninho", "serginho", "wandin",
  "jorgin", "edin", "peixoto", "negao", "cacau", "vitin", "thiagao", "marcelin",
  "rondinelli", "wellingtin", "jefin", "kleberson", "ronaldao", "adilson",
];

/** O tique mais identificável da voz: sufixo espanholizado em cima de qualquer nome. */
const NAME_SUFFIXES = [
  "", "", "", "", "ales", "itos", "inho", "ables", "zin", " oficial",
  " oficiale", " real oficial", "oficialito",
];

/**
 * Nome de exibição do cliente `index`. Estável entre runs, e único o bastante
 * para que a lista de presença não vire uma parede do mesmo apelido.
 */
export function nameFor(index) {
  const r = rng(index * 2654435761);
  const stem = pick(NAME_STEMS, r);
  const suffix = pick(NAME_SUFFIXES, r);
  // O índice entra só quando o par escolhido já saiu antes, o que a essa altura
  // é garantido em qualquer run acima de algumas centenas de clientes.
  const collides = index >= NAME_STEMS.length;
  return `${stem}${suffix}${collides ? ` ${index}` : ""}`.trim();
}

/* ------------------------------------------------------------------ */
/* mensagens                                                           */
/* ------------------------------------------------------------------ */

/** Reações de uma linha. Curtas de propósito: é o que mais aparece no corpus. */
const REACTIONS = [
  "brutal", "estou gag", "fiquei gag com isso", "é foda bicho", "ce ta doido",
  "ta maluco", "papo reto demais", "que doideira", "meu deus", "wtf mano",
  "só o oro", "fica só o oro", "fera demais", "A FERA é fera", "tamo junto",
  "ficou do caralho", "puta q pariu", "essa pora é boa demais", "bizarro",
  "what a time to be alive", "que época para se estar vivo amigos", "oloco",
  "carambolas", "top do top", "fino do fino", "creme de la creme", "quente demais",
  "isso aqui é papo reto", "VAMO PORA rapazeada", "BRUTAL demais", "vamooooooooooo",
  "kkkkkkkkkkkkkkkkkkkk", "deita o cabelo", "é real oficial", "vida q segue",
];

/** Frases com número concreto — a marca do build in public. */
const NUMBERS = [
  "hoje fazemos 11tb por dia bicho",
  "faziamos isso por mes em dezembro",
  "0.06U$/h e ninguem acredita",
  "150tb de storage e a conta nao fecha",
  "10k de mrr e o pai ta so começando",
  "74.600R$ em um mes rapazeada",
  "9 gpus h200 rodando agora",
  "18h de treinamento e o cara reclama",
  "37mil ienes de servidor por mes",
  "200k de mrr no escuro é burrice",
  "storage vagabundo de 2U$/TB nao existe mais",
  "conta de padeiro: 3 shards, 300k socket",
];

/** Perguntas para a audiência. Abrem enquete informal, como no perfil. */
const QUESTIONS = [
  "será q vai aguentar",
  "será q alguem ja fez isso antes",
  "cade a rapazeada dos games",
  "cade a rapazeada do backend",
  "é normal essa pora",
  "isso escala ou to viajando",
  "alguem ai ja rodou isso em prod",
  "quanto custaria isso na aws bicho",
];

/** Hype e convocação comercial. */
const HYPE = [
  "o futuro é glorioso senhores",
  "bora crescer",
  "bora fazer dinheiro",
  "vamo fazer acontecer",
  "vem ganhar dinheiro conosco",
  "vem escalar conosco",
  "we are so back",
  "its showtime folks",
  "deus abençoe a inteligencia artificial",
  "que deus tenha piedade desse deploy",
  "o pai ta criando musculo",
  "cola comigo que o pai faz magica",
];

/** As fórmulas de preenchimento variável — o que mais soa como ele. */
const TARGETS = [
  "os dbas", "o beta bilionario", "a concorrencia", "os gringo", "a betastation",
  "o pessoal do polling", "os cara do socket.io", "a turma do long polling",
  "quem cobra por espectador", "os vagabundo do downtime",
];

const FORMULAS = [
  (t) => `nao sobra nada pro ${t}`,
  (t) => `vamos botar ${t} pra mamar`,
  (t) => `se ${t} nao tiver isso ta deixando dinheiro na mesa`,
  (t) => `${t} é uma mina de ouro bicho`,
];

/** Autodepreciação — metade da graça da voz é essa. */
const SELF = [
  "comendo hot pocket enquanto o deploy sobe",
  "eu sou um bosta ainda",
  "monster e redbull, o combustivel do real oficial",
  "esse gordola aqui aguenta mais um run",
  "to no ribeirao shopping vendo isso subir",
  "levanta imediatamente essa bunda preguiçosa",
  "LIGHTWEIGHT baby",
];

/** Vocativos, colados no fim. O vazio é o mais comum de propósito. */
const VOCATIVES = ["", "", "", "", " bicho", " mano", " rapazeada", " dog", " filho", " senhores", " fellas", " malandro"];

const POOLS = [
  { weight: 30, lines: REACTIONS },
  { weight: 18, lines: NUMBERS },
  { weight: 14, lines: QUESTIONS },
  { weight: 16, lines: HYPE },
  { weight: 12, lines: SELF },
];
const TOTAL_WEIGHT = POOLS.reduce((sum, p) => sum + p.weight, 0);
/** O que sobra dos pesos acima vai para as fórmulas com alvo variável. */
const FORMULA_SHARE = 100 - TOTAL_WEIGHT;

function phraseFor(r) {
  let roll = r() * (TOTAL_WEIGHT + FORMULA_SHARE);
  for (const pool of POOLS) {
    if (roll < pool.weight) return pick(pool.lines, r);
    roll -= pool.weight;
  }
  return pick(FORMULAS, r)(pick(TARGETS, r));
}

/**
 * Corpo de uma mensagem.
 *
 * `sentAt` viaja no fim: é o que permite a *quem recebe* medir a latência de
 * entrega fim a fim, e sem ele o número mais importante do relatório some.
 */
export function messageFor(index, seq, sentAt) {
  const r = rng(index * 0x9e3779b1 + seq * 0x85ebca6b);
  const phrase = phraseFor(r);
  const vocative = pick(VOCATIVES, r);
  return `${phrase}${vocative} @${sentAt}|`;
}
