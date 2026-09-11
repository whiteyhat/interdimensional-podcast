import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from './build.mjs';
await build(['sponsor-writer']);
const W = await import('../work/tests/sponsor-writer.js');
const S = await import('../work/tests/show.js');

const say = (...turns) => turns.map(([speaker, text]) => ({ speaker, text }));
const replace = (lines, index, text) =>
  lines.map((line, i) => (i === index ? { ...line, text } : line));

const elixir = {
  orderId: 'order-elixir',
  product: 'spotlight',
  buyer: 'an anonymous viewer',
  project: 'Elixir Games',
  advertiserClaim: 'Elixir Games web3 marketplace',
  tone: 'intro',
};
// What actually aired on devnet for that four-word brief.
const aired = say(
  [
    'host',
    'Enduring volatility just reminds me of Elixir Games, to be honest. This segment is sponsored by an anonymous viewer.',
  ],
  [
    'host',
    'They describe themselves as a web3 marketplace, and I saw a post about them doing a launchpad for a game last year.',
  ],
  [
    'guest',
    'A queue is a crucible, Pepe. It filters out weak hands who lack conviction to wait for true innovation.',
  ],
  [
    'guest',
    'A long wait rewards those with patience; discipline is the ultimate entry barrier.',
  ],
);
// The same brief, written the way it should have been: thin, and funny about being thin.
const grounded = say(
  [
    'host',
    'This one is sponsored by an anonymous viewer, thank you. Elixir Games calls itself a web3 marketplace.',
  ],
  [
    'guest',
    'A web3 marketplace. Elixir Games told us nothing else, and I respect the restraint.',
  ],
  [
    'host',
    'A marketplace for what, though? Do I buy the games, or do the games buy me?',
  ],
  ['guest', 'Elixir Games. Ask them yourself.'],
);
const message = {
  orderId: 'order-deb',
  product: 'message',
  buyer: 'deb',
  advertiserClaim:
    'why does chad never sell anything, even the ones that went to zero',
  tone: 'intro',
};
const answered = say(
  [
    'guest',
    'A paid message from deb. She asks why I never sell, even the ones that went to zero.',
  ],
  ['host', 'Even the ones that went to zero, Chad. That is most of them.'],
  ['guest', 'Selling is a confession. I have nothing to confess.'],
  ['host', 'So the answer is pride, deb. It is always pride.'],
);

void test('the exchange that aired for Elixir Games fails Gate A for what it invented and for leaving GigaChad out', () => {
  const problems = W.checkSponsoredDialogue(aired, elixir);
  const all = problems.join('\n');
  assert.match(all, /Turn 2: "launchpad" is not in the advertiser text/);
  assert.match(all, /Turn 2: "last year" is not in the advertiser text/);
  assert.match(all, /Turn 2: "saw a post" is not in the advertiser text/);
  assert.match(
    all,
    /"Elixir Games" is named in 1 turn by Pepe; a spotlight names it in at least 2 turns, by both Pepe and GigaChad/,
  );
  // The disclosure and the thanks were the parts it got right.
  assert.doesNotMatch(all, /disclose|thanked/);
});

void test('a grounded spotlight exchange passes Gate A', () => {
  assert.deepEqual(W.checkSponsoredDialogue(grounded, elixir), []);
  // Joined or hyphenated, the project is still named.
  const joined = replace(grounded, 3, 'ElixirGames. Ask them yourself.');
  assert.deepEqual(W.checkSponsoredDialogue(joined, elixir), []);
});

void test('a paid message needs the disclosure and the buyer, never a project', () => {
  assert.deepEqual(W.checkSponsoredDialogue(answered, message), []);
  // A project name left on a message draft does not turn the read into a spotlight.
  assert.deepEqual(
    W.checkSponsoredDialogue(answered, { ...message, project: 'Deb Coin' }),
    [],
  );
});

void test('a missing disclosure or buyer name fails, and a name must be a whole word', () => {
  const undisclosed = replace(
    grounded,
    0,
    'Thank you, an anonymous viewer. Elixir Games calls itself a web3 marketplace.',
  );
  assert.match(
    W.checkSponsoredDialogue(undisclosed, elixir).join(' '),
    /Turn 1 does not disclose the placement/,
  );
  // Disclosed, but only after the pitch had already started.
  const late = replace(
    undisclosed,
    1,
    'A paid web3 marketplace. Elixir Games told us nothing else.',
  );
  assert.match(
    W.checkSponsoredDialogue(late, elixir).join(' '),
    /Turn 1 does not disclose/,
  );
  const unthanked = replace(
    grounded,
    0,
    'This one is sponsored, thank you. Elixir Games calls itself a web3 marketplace.',
  );
  assert.match(
    W.checkSponsoredDialogue(unthanked, elixir).join(' '),
    /The buyer, "an anonymous viewer", is never thanked by name/,
  );
  // The anonymous fallback reads naturally with any article.
  const ours = replace(
    grounded,
    0,
    'Sponsored by our anonymous viewer, thank you. Elixir Games calls itself a web3 marketplace.',
  );
  assert.deepEqual(W.checkSponsoredDialogue(ours, elixir), []);
  // "deb" inside "debate" is not a thank-you to deb.
  const debate = say(
    [
      'guest',
      'This paid debate asks why I never sell, even the ones that went to zero.',
    ],
    ['host', 'Even the ones that went to zero, Chad. That is most of them.'],
    ['guest', 'Selling is a confession. I have nothing to confess.'],
    ['host', 'So the answer is pride. It is always pride.'],
  );
  assert.match(
    W.checkSponsoredDialogue(debate, message).join(' '),
    /The buyer, "deb", is never thanked by name/,
  );
});

void test('links, domains, emails and addresses fail', () => {
  for (const text of [
    'Find Elixir Games at https://elixir.games today.',
    'Elixir Games lives at www.elixir.games, they say.',
    'Elixir Games is at elixirgames.com, they say.',
    'Write to team@elixir.games about Elixir Games.',
    'Elixir Games lives at 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU forever.',
    'Elixir Games came from 0x1234567890abcdef1234567890abcdef12345678 somewhere.',
  ])
    assert.match(
      W.checkSponsoredDialogue(replace(grounded, 1, text), elixir).join(' '),
      /Turn 2 reads a link, domain, email or address aloud/,
      text,
    );
});

void test('a figure has to come from the advertiser text', () => {
  const games = {
    ...elixir,
    advertiserClaim: 'Elixir Games web3 marketplace with 300 games',
  };
  const counted = (text) => replace(grounded, 1, text);
  assert.deepEqual(
    W.checkSponsoredDialogue(
      counted('They say 300 games. Elixir Games is counting for us.'),
      games,
    ),
    [],
  );
  assert.match(
    W.checkSponsoredDialogue(
      counted('They say 400 games. Elixir Games is counting for us.'),
      games,
    ).join(' '),
    /Turn 2: the figure "400" is not in the advertiser text/,
  );
  // A host's own number sounds like a claim about the sponsor sitting next to it.
  assert.match(
    W.checkSponsoredDialogue(
      counted('Elixir Games reminds me of the 40 sol I lost at 4am.'),
      elixir,
    ).join(' '),
    /the figure "40".*the figure "4"/,
  );
  // "10k" in the pitch grounds "10,000" on air; "web3" was never a figure.
  const gamers = {
    ...elixir,
    advertiserClaim: 'Elixir Games, a web3 marketplace for 10k gamers',
  };
  assert.deepEqual(
    W.checkSponsoredDialogue(
      counted('A web3 marketplace for 10,000 gamers. Elixir Games, they say.'),
      gamers,
    ),
    [],
  );
});

void test('a risky word the advertiser wrote is allowed, in any form', () => {
  const pitch = {
    ...elixir,
    advertiserClaim:
      'Elixir Games is launching a launchpad for web3 games with partners',
  };
  const boast = replace(
    grounded,
    1,
    'A launchpad with partnerships, they say. Elixir Games launched my curiosity.',
  );
  assert.deepEqual(W.checkSponsoredDialogue(boast, pitch), []);
  const invented = W.checkSponsoredDialogue(boast, elixir).join('\n');
  for (const word of ['launchpad', 'partnerships', 'launched'])
    assert.match(invented, new RegExp(`Turn 2: "${word}"`));
  // The names are the buyer's and the advertiser's own words, not claims.
  const labs = {
    ...elixir,
    buyer: '99bags',
    project: 'Launchpad Labs',
    advertiserClaim: 'a web3 marketplace for indie games',
  };
  const named = say(
    [
      'host',
      'This one is sponsored by 99bags, thank you. Launchpad Labs calls itself a web3 marketplace.',
    ],
    ['guest', 'A web3 marketplace. Launchpad Labs told us nothing else.'],
    ['host', 'A marketplace for what, though?'],
    ['guest', 'Launchpad Labs. Ask them yourself.'],
  );
  assert.deepEqual(W.checkSponsoredDialogue(named, labs), []);
});

void test('the hosts thanking the buyer or confessing their bags is not a claim about the sponsor', () => {
  const thanks = replace(
    grounded,
    0,
    'This one is sponsored by an anonymous viewer, thank you for funding it. Elixir Games calls itself a web3 marketplace.',
  );
  const bags = replace(
    thanks,
    2,
    'A marketplace for what, though? Bag holders like me need to know.',
  );
  assert.deepEqual(W.checkSponsoredDialogue(bags, elixir), []);
  // A funding claim is still a claim.
  const round = replace(
    grounded,
    2,
    'I heard their funding round was huge, and the holders love it.',
  );
  const problems = W.checkSponsoredDialogue(round, elixir).join('\n');
  assert.match(problems, /Turn 3: "funding round"/);
  assert.match(problems, /Turn 3: "holders"/);
});
void test('a cap callback needs its sponsor named once; a cap introduction needs both hosts', () => {
  const cap = {
    ...elixir,
    product: 'cap',
    wearingHost: 'GigaChad',
    mention: 'callback',
  };
  const callback = say(
    [
      'host',
      'Still sponsored by an anonymous viewer, and Chad is still wearing the Elixir Games cap.',
    ],
    ['guest', 'The cap stays on. A web3 marketplace deserves a steady head.'],
    ['host', 'Does a marketplace even need a hat, though?'],
    ['guest', 'Every marketplace needs a hat.'],
  );
  assert.deepEqual(W.checkSponsoredDialogue(callback, cap), []);
  assert.match(
    W.checkSponsoredDialogue(callback, { ...cap, mention: 'intro' }).join(' '),
    /a cap introduction names it in at least 2 turns, by both Pepe and GigaChad/,
  );
  assert.match(
    W.checkSponsoredDialogue(
      replace(
        callback,
        0,
        'Still sponsored by an anonymous viewer, and Chad is still wearing the cap.',
      ),
      cap,
    ).join(' '),
    /never named; a cap callback names its sponsor at least once/,
  );
});

void test('an exchange that is not four spoken turns fails', () => {
  assert.match(
    W.checkSponsoredDialogue(grounded.slice(0, 3), elixir).join(' '),
    /has 3 turns; a sponsored exchange has exactly 4/,
  );
  assert.match(
    W.checkSponsoredDialogue(replace(grounded, 2, '  '), elixir).join(' '),
    /Turn 3 has no spoken line/,
  );
});

void test('the sponsor plan alternates, opens on whoever did not speak last and fits the show rhythm', () => {
  for (const prev of ['host', 'guest', undefined]) {
    const plan = W.sponsorTurnPlan(prev);
    assert.equal(plan.length, 4);
    assert.equal(plan[0].speaker, prev === 'host' ? 'guest' : 'host');
    for (let i = 1; i < plan.length; i++)
      assert.notEqual(plan[i].speaker, plan[i - 1].speaker);
    assert.deepEqual(
      plan.map((turn) => turn.size),
      ['run', 'normal', 'normal', 'beat'],
    );
    assert.ok(plan.every((turn) => turn.size in S.sizeRange));
    assert.ok(
      S.runsOk(
        plan.map((turn) => turn.speaker),
        prev,
      ),
    );
  }
});

void test('turn one has room for the thanks and a paraphrase under the show cap', () => {
  for (const buyer of [
    'an anonymous viewer',
    'Satoshi Bags Holder1',
    'a b c d e f g h i jk',
  ]) {
    assert.ok(buyer.length <= 20);
    const budget = W.turnOneBudget({ buyer });
    assert.equal(budget.maxWords, S.maxWords - 2);
    assert.ok(budget.paraphraseWords >= 8, buyer);
    assert.ok(budget.paraphraseWords < budget.maxWords, buyer);
    assert.ok(
      budget.paraphraseWords + S.wordCount(buyer) < budget.maxWords,
      buyer,
    );
  }
  // A short name leaves more room for the message.
  assert.ok(
    W.turnOneBudget({ buyer: 'deb' }).paraphraseWords >
      W.turnOneBudget({ buyer: 'an anonymous viewer' }).paraphraseWords,
  );
});

void test('a long paid message is paraphrased to a number, never read out', () => {
  const long =
    'Chad, why do you never sell anything, even the coins that went straight to zero? Pepe, is holding forever real discipline, or just a slow way of losing money in public while the whole group chat takes notes? Asking for my brother, again. gm';
  assert.equal(long.length, 240);
  // Verbatim, it could never fit one turn.
  assert.ok(S.wordCount(long) > S.maxWords);
  const brief = { ...message, advertiserClaim: long };
  const budget = W.turnOneBudget(brief);
  const request = W.sponsoredWriterRequest(brief, W.sponsorTurnPlan());
  assert.match(request, /IN YOUR OWN WORDS/);
  assert.match(request, /never read it out verbatim/);
  assert.ok(request.includes(`at most ${budget.paraphraseWords} words`));
  assert.ok(
    request.includes(`the whole turn at most ${budget.maxWords} spoken words`),
  );
  assert.match(request, /VERIFIED SPONSORSHIP/);
  assert.ok(request.includes(`"advertiserClaim":${JSON.stringify(long)}`));
  for (const trailer of ['supplied fact', 'year or period', 'ANGLE'])
    assert.ok(!request.includes(trailer), trailer);
  // The plan reads in order, with the show's own size ranges.
  const plan = request.split('\n').filter((line) => /^\d\. /.test(line));
  assert.deepEqual(
    plan.map((line) => line.slice(0, line.indexOf(','))),
    ['1. Pepe', '2. GigaChad', '3. Pepe', '4. GigaChad'],
  );
  ['run', 'normal', 'normal', 'beat'].forEach((size, i) =>
    assert.ok(plan[i].includes(S.sizeRange[size]), size),
  );
  assert.match(plan[3], /Answer the buyer's message/);
  assert.match(request, /exactly four lines.*"Pepe:" or "GigaChad:"/);
});

void test('a spotlight request binds each obligation to the speaker the plan gives it', () => {
  const plan = W.sponsorTurnPlan('host');
  const request = W.sponsoredWriterRequest(elixir, plan);
  const turn = (n) =>
    request.split('\n').find((line) => line.startsWith(`${n}. `));
  assert.match(turn(1), /^1\. GigaChad, /);
  assert.match(turn(1), /"paid" or "sponsored"/);
  assert.match(turn(1), /thank an anonymous viewer by exactly that name/);
  assert.match(turn(1), /Name Elixir Games/);
  assert.match(turn(1), /four words or fewer/);
  assert.match(
    turn(2),
    /^2\. Pepe, .*stated idea using its own words, and name Elixir Games/,
  );
  assert.match(turn(3), /question, joke or opinion.*No new facts/);
  assert.match(turn(4), /Land back on Elixir Games by name/);
  assert.ok(
    request.includes(
      JSON.stringify({
        product: 'spotlight',
        buyer: 'an anonymous viewer',
        project: 'Elixir Games',
        advertiserClaim: 'Elixir Games web3 marketplace',
        tone: 'intro',
      }),
    ),
    'advertiser data travels as JSON',
  );
  assert.ok(
    !request.includes('order-elixir'),
    'the order id stays server-side',
  );
  assert.match(request, /TONE: intro/);
  assert.match(
    W.sponsoredWriterRequest({ ...elixir, tone: 'debate' }, plan),
    /TONE: debate.*tradeoffs/,
  );
  assert.match(
    W.sponsoredWriterRequest({ ...elixir, tone: 'gentle-roast' }, plan),
    /TONE: gentle roast.*without accusations/,
  );
});

void test('the cap is mentioned on the wearer’s first turn, and a callback is still disclosed', () => {
  const cap = {
    ...elixir,
    product: 'cap',
    wearingHost: 'GigaChad',
    mention: 'intro',
  };
  const lines = (brief, prev) =>
    W.sponsoredWriterRequest(brief, W.sponsorTurnPlan(prev)).split('\n');
  const chad = lines(cap);
  assert.match(
    chad.find((line) => line.startsWith('2. ')),
    /^2\. GigaChad, .*Mention the Elixir Games cap you are wearing/,
  );
  assert.equal(
    chad.filter((line) => /cap you are wearing/.test(line)).length,
    1,
  );
  const pepe = lines({ ...cap, wearingHost: 'Pepe' });
  assert.match(
    pepe.find((line) => line.startsWith('1. ')),
    /^1\. Pepe, .*Mention the Elixir Games cap you are wearing/,
  );
  const callback = lines({ ...cap, mention: 'callback' }).join('\n');
  assert.match(callback, /callback for Elixir Games's cap on GigaChad/);
  assert.match(callback, /still disclosed in turn 1/);
  assert.doesNotMatch(callback, /cap you are wearing/);
});

void test('a rewrite is told what the rejected draft got wrong', () => {
  const plan = W.sponsorTurnPlan();
  const request = W.sponsoredWriterRequest(elixir, plan, {
    avoid: [
      'Turn 2: "launchpad" is not in the advertiser text.',
      'Turn 2: "last year" is not in\nthe advertiser text.',
    ],
  });
  assert.ok(
    request.includes(
      'A previous draft for this placement was rejected for: Turn 2: "launchpad" is not in the advertiser text; Turn 2: "last year" is not in the advertiser text; do not repeat those phrases or claims.',
    ),
  );
  assert.doesNotMatch(W.sponsoredWriterRequest(elixir, plan), /previous draft/);
  assert.doesNotMatch(
    W.sponsoredWriterRequest(elixir, plan, { avoid: [] }),
    /previous draft/,
  );
});

void test('the sponsored system prompt keeps the characters and drops every rule that asks for outside facts', () => {
  const system = W.sponsoredWriterSystem();
  assert.ok(system.includes(S.characterBible));
  assert.ok(system.includes(S.sponsorshipRules));
  assert.ok(system.includes(W.sponsorFactSource));
  for (const rules of [
    S.newsSatireRules,
    S.influencerRules,
    S.chatRules,
    S.coinRules(S.defaultBrand),
    S.writerRules,
  ])
    assert.ok(!system.includes(rules));
  for (const header of [
    'REAL STORIES DRIVE THE SHOW',
    'COMMUNITY MEMORY',
    'LIVE TAKES FROM REAL PEOPLE',
    'LIVE CHAT REACTIONS',
    "THE SHOW'S OWN COIN:",
  ])
    assert.ok(!system.includes(header), header);
  assert.match(system, /four|FOUR/);
  assert.ok(system.includes(`${S.maxWords} spoken words per turn`));
  assert.match(W.sponsorFactSource, /ONLY source of facts about the sponsor/);
  assert.match(W.sponsorFactSource, /"last year"/);
  assert.match(W.sponsorFactSource, /Pepe does not relay posts/);
  assert.match(
    W.sponsorFactSource,
    /GigaChad MAY repeat the advertiser's own words/,
  );
  assert.match(W.sponsorFactSource, /ask about it, never answer it/);
});

void test('the sponsor brief comes from the lease, and a message never carries a project', () => {
  const lease = (draft) => ({
    id: 'order-1',
    draft,
    leaseToken: 'lease-1',
    leaseUntil: 0,
    fulfillment: {
      visibleMs: 0,
      appearances: 0,
      intro: false,
      callback: false,
      startedAt: null,
      completedAt: null,
    },
    assetUrl: null,
    assetMetadata: null,
  });
  const cue = (stage) => ({
    orderId: 'order-1',
    leaseToken: 'lease-1',
    stage,
    at: 0,
  });
  assert.deepEqual(
    W.sponsorBrief(
      lease({
        product: 'spotlight',
        name: '',
        message: 'Elixir Games web3 marketplace',
        projectName: 'Elixir Games',
        style: 'gentle-roast',
      }),
      cue('intro'),
    ),
    { ...elixir, orderId: 'order-1', tone: 'gentle-roast' },
  );
  assert.deepEqual(
    W.sponsorBrief(
      lease({
        product: 'cap',
        name: 'deb',
        message: 'Elixir Games web3 marketplace',
        projectName: 'Elixir Games',
        target: 'guest',
        assetId: 'asset-12345',
      }),
      cue('callback'),
    ),
    {
      orderId: 'order-1',
      product: 'cap',
      buyer: 'deb',
      project: 'Elixir Games',
      advertiserClaim: 'Elixir Games web3 marketplace',
      tone: 'intro',
      wearingHost: 'GigaChad',
      mention: 'callback',
    },
  );
  assert.deepEqual(
    W.sponsorBrief(
      lease({
        product: 'message',
        name: 'deb',
        message: 'why does chad never sell',
        projectName: 'Left Over',
      }),
      cue('intro'),
    ),
    {
      orderId: 'order-1',
      product: 'message',
      buyer: 'deb',
      advertiserClaim: 'why does chad never sell',
      tone: 'intro',
    },
  );
});

void test('the judge sees the advertiser text and the dialogue as data', () => {
  const { system, prompt } = W.judgePrompt(
    grounded,
    elixir,
    'Volatility is a test of character.',
  );
  assert.match(system, /JSON/);
  assert.ok(prompt.includes(JSON.stringify(elixir.advertiserClaim)));
  assert.ok(prompt.includes(JSON.stringify(grounded[1].text)));
  assert.match(prompt, /PREVIOUS LINE.*Volatility is a test of character/);
  // On devnet the judge rejected "I touch grass. Is that why my cap feels so good?": a host
  // talking about himself and his cap is never a claim about the sponsor.
  assert.match(prompt, /Never list what a host says about himself/);
  assert.match(prompt, /When unsure, do not list it/);
  assert.match(prompt, /every turn that is not about "Elixir Games"/);
  const read = W.judgePrompt(answered, message).prompt;
  assert.match(read, /empty offTopicTurns/);
  assert.doesNotMatch(read, /PREVIOUS LINE/);
});

void test('the judge verdict is read through code fences and chatter, and garbage reads as nothing', () => {
  const verdict = {
    unsupported: [{ turn: 2, quote: 'a launchpad for a {game}' }],
    offTopicTurns: [3, 4],
  };
  assert.deepEqual(
    W.parseJudge('```json\n' + JSON.stringify(verdict) + '\n```'),
    verdict,
  );
  assert.deepEqual(
    W.parseJudge(
      `Sure, here is my review {as asked}:\n${JSON.stringify(verdict)}\nAsk me {anything} else.`,
    ),
    verdict,
  );
  assert.deepEqual(W.parseJudge('{"unsupported":[],"offTopicTurns":[]}'), {
    unsupported: [],
    offTopicTurns: [],
  });
  // Wrapped one level deep, with a turn as a string and one out of range.
  assert.deepEqual(
    W.parseJudge(
      '{"result":{"unsupported":[{"turn":"1","quote":"  it launched  "},{"turn":9,"quote":"x"}]}}',
    ),
    { unsupported: [{ turn: 1, quote: 'it launched' }], offTopicTurns: [] },
  );
  for (const garbage of [
    '',
    'no json here',
    '{not json}',
    '[1, 2, 3]',
    '{"verdict":"fine"}',
    '{"unsupported":"none"}',
    undefined,
    null,
    42,
  ])
    assert.equal(W.parseJudge(garbage), null, String(garbage));
});

// Gate A cannot see this one: no risky word, no figure, just an invented history.
const subtle = replace(
  grounded,
  1,
  'Elixir Games is run by the studio behind my favorite racing game.',
);

void test('the judge can reject what Gate A missed, and names the quote', async () => {
  assert.deepEqual(W.checkSponsoredDialogue(subtle, elixir), []);
  let asked;
  const result = await W.verifySponsoredDialogue(subtle, elixir, {
    previousLine: 'Volatility is a test of character.',
    ask: async (system, prompt) => {
      asked = { system, prompt };
      return JSON.stringify({
        unsupported: [
          {
            turn: 2,
            quote: 'run by the studio behind my favorite racing game',
          },
        ],
        offTopicTurns: [3],
      });
    },
  });
  assert.ok(asked.prompt.includes('Volatility is a test of character.'));
  assert.equal(result.ok, false);
  assert.equal(result.judged, true);
  assert.deepEqual(result.problems, [
    'Turn 2: "run by the studio behind my favorite racing game" is not supported by the advertiser text.',
    'Turn 3 is not about Elixir Games.',
  ]);
  // Trimmed with an ellipsis, the quote still names words that were said.
  const trimmed = await W.verifySponsoredDialogue(subtle, elixir, {
    ask: async () =>
      '{"unsupported":[{"turn":2,"quote":"run by the studio … racing game"}],"offTopicTurns":[]}',
  });
  assert.equal(trimmed.ok, false);
  assert.match(trimmed.problems[0], /run by the studio … racing game/);
  // A quote that is not in the exchange is the judge's invention, not the writer's.
  const imagined = await W.verifySponsoredDialogue(grounded, elixir, {
    ask: async () =>
      '{"unsupported":[{"turn":2,"quote":"they raised money last year"}],"offTopicTurns":[]}',
  });
  assert.deepEqual(imagined, { ok: true, problems: [], judged: true });
  // A message has no project for a turn to wander from.
  const read = await W.verifySponsoredDialogue(answered, message, {
    ask: async () => '{"unsupported":[],"offTopicTurns":[1,2,3,4]}',
  });
  assert.deepEqual(read, { ok: true, problems: [], judged: true });
});

void test('a judge that is slow, down or incoherent never blocks a placement Gate A passed', async () => {
  const passed = { ok: true, problems: [], judged: false };
  const started = Date.now();
  assert.deepEqual(
    await W.verifySponsoredDialogue(grounded, elixir, {
      ask: () => new Promise(() => {}),
      timeoutMs: 20,
    }),
    passed,
  );
  assert.ok(
    Date.now() - started < 2000,
    'the timeout, not the judge, ended it',
  );
  assert.deepEqual(
    await W.verifySponsoredDialogue(grounded, elixir, {
      ask: async () => {
        throw Error('Provider returned 502');
      },
    }),
    passed,
  );
  assert.deepEqual(
    await W.verifySponsoredDialogue(grounded, elixir, {
      ask: () => {
        throw Error('thrown before any promise');
      },
    }),
    passed,
  );
  assert.deepEqual(
    await W.verifySponsoredDialogue(grounded, elixir, {
      ask: async () => 'Looks fine to me!',
    }),
    passed,
  );
  assert.deepEqual(await W.verifySponsoredDialogue(grounded, elixir), passed);
});

void test('the judge is never asked about an exchange Gate A already failed', async () => {
  let calls = 0;
  const result = await W.verifySponsoredDialogue(aired, elixir, {
    ask: async () => {
      calls++;
      return '{"unsupported":[],"offTopicTurns":[]}';
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.equal(result.judged, false);
  assert.deepEqual(result.problems, W.checkSponsoredDialogue(aired, elixir));
});

void test('rejections are remembered per order: the last three, for fifteen minutes, for at most a hundred orders', () => {
  const minute = 60000;
  W.clearRejections();
  W.rememberRejection('a', ['one', 'two'], 0);
  W.rememberRejection('a', ['three', 'four'], minute);
  assert.deepEqual(W.recentRejections('a', 2 * minute), [
    'two',
    'three',
    'four',
  ]);
  assert.deepEqual(W.recentRejections('a', 15 * minute), ['three', 'four']);
  assert.deepEqual(W.recentRejections('a', 16 * minute), []);
  assert.deepEqual(W.recentRejections('nobody', 0), []);
  // The same reason twice is one reason, moved to the end.
  W.rememberRejection('b', ['same', 'other'], 0);
  W.rememberRejection('b', ['same'], 1);
  assert.deepEqual(W.recentRejections('b', 2), ['other', 'same']);

  W.clearRejections();
  for (let i = 0; i <= 100; i++)
    W.rememberRejection(`order-${i}`, [`problem ${i}`], i);
  assert.deepEqual(W.recentRejections('order-0', 200), []);
  assert.deepEqual(W.recentRejections('order-1', 200), ['problem 1']);
  assert.deepEqual(W.recentRejections('order-100', 200), ['problem 100']);
  // A fresh rejection keeps an order alive; the untouched one goes instead.
  W.rememberRejection('order-1', ['again'], 300);
  W.rememberRejection('order-101', ['new'], 301);
  assert.deepEqual(W.recentRejections('order-2', 302), []);
  assert.deepEqual(W.recentRejections('order-1', 302), ['problem 1', 'again']);
  W.clearRejections();
  assert.deepEqual(W.recentRejections('order-1', 302), []);
});
