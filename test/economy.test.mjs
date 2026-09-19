// The carry-over economy: overtime is borrowed from tomorrow, thrift is banked.
// Everything here is arithmetic the rest of the extension leans on, so it is
// tested at the boundaries, not just in the middle.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  carryForward, carryChain, entBands, stackParts, allowanceFor, chargedFor,
  remainingFor, NO_CARRY, dayRange, MAX_DEBT_MULT,
} from '../src/lib/model.js';

const M = (n) => n * 60000;
const H = M(60);
const mins = (ms) => Math.round(ms / 60000);

// ------------------------------------------------------------ one day's close

test('a day inside the limit banks two thirds of what was left', () => {
  assert.deepEqual(carryForward(M(30), NO_CARRY, H), { debt: 0, bonus: M(20) });
});

test('a day that spends exactly the limit banks nothing and owes nothing', () => {
  assert.deepEqual(carryForward(H, NO_CARRY, H), { debt: 0, bonus: 0 });
});

test('a day past the limit owes the excess, to the minute', () => {
  assert.deepEqual(carryForward(M(83), NO_CARRY, H), { debt: M(23), bonus: 0 });
});

test('a day with nothing watched banks two thirds of the whole limit', () => {
  assert.deepEqual(carryForward(0, NO_CARRY, H), { debt: 0, bonus: M(40) });
});

test('banked time raises the ceiling it is measured against', () => {
  const carryIn = { debt: 0, bonus: M(30) };
  assert.equal(allowanceFor(carryIn, H), M(90));
  // 80m spent against a 90m ceiling is still under: 10m left, two thirds banked.
  assert.deepEqual(carryForward(M(80), carryIn, H), { debt: 0, bonus: Math.round(M(10) * 2 / 3) });
});

test('debt is charged before a minute is watched', () => {
  const carryIn = { debt: M(25), bonus: 0 };
  assert.equal(chargedFor(M(10), carryIn), M(35));
  assert.equal(remainingFor(M(10), carryIn, H), M(25));
  // 40m watched on top of 25m owed is 65m against a 60m limit: 5m owed again.
  assert.deepEqual(carryForward(M(40), carryIn, H), { debt: M(5), bonus: 0 });
});

test('debt bigger than the limit leaves the next day already over', () => {
  const carryIn = { debt: M(95), bonus: 0 };
  assert.equal(remainingFor(0, carryIn, H), M(-35));
  assert.deepEqual(carryForward(0, carryIn, H), { debt: M(35), bonus: 0 });
});

test('a day under the limit while in debt still pays some of it down', () => {
  let carry = { debt: M(150), bonus: 0 }; // more than the cap allows to accrue, but valid input
  const owed = [];
  for (let day = 0; day < 4; day += 1) {
    carry = carryForward(0, carry, H);
    owed.push(mins(carry.debt));
  }
  assert.deepEqual(owed, [90, 30, 0, 0], 'an hour of debt clears per idle day, then it banks');
});

test('debt cannot compound past the cap, so there is always a way back', () => {
  let carry = NO_CARRY;
  for (let day = 0; day < 20; day += 1) carry = carryForward(M(300), carry, H); // five hours, daily
  assert.equal(mins(carry.debt), 120, `capped at ${MAX_DEBT_MULT} days' worth`);
  // And from the worst case, two clean days clear it entirely.
  carry = carryForward(0, carry, H);
  assert.equal(mins(carry.debt), 60);
  carry = carryForward(0, carry, H);
  assert.equal(carry.debt, 0);
});

test('the cap does not soften a single bad evening', () => {
  assert.deepEqual(carryForward(M(95), NO_CARRY, H), { debt: M(35), bonus: 0 },
    'an ordinary overrun travels in full');
});

// ------------------------------------------------------------------ the chain

test('the chain walks days forward, and a gap day earns like an idle one', () => {
  const chain = carryChain({ '2026-09-01': M(90), '2026-09-03': M(10) }, '2026-09-04', H);
  assert.deepEqual(chain['2026-09-01'], NO_CARRY, 'the first day starts clean');
  assert.deepEqual(chain['2026-09-02'], { debt: M(30), bonus: 0 }, 'yesterday went 30m over');
  // 2 Sep is charged 30m of debt and watches nothing: 30m left of 60m, 20m banked.
  assert.deepEqual(chain['2026-09-03'], { debt: 0, bonus: M(20) });
  // 3 Sep: 10m watched against 80m -> 70m left -> 46m40s banked.
  assert.deepEqual(mins(chain['2026-09-04'].bonus), 47);
});

test('the bank converges instead of growing forever', () => {
  const chain = carryChain({ '2026-01-01': 0 }, '2026-03-01', H);
  const last = chain['2026-03-01'];
  assert.equal(last.debt, 0);
  // Banking 2/3 of what is left settles at bonus = limit·share/(1-share) = 2·limit.
  assert.equal(mins(last.bonus), 120, 'two months away buys two bonus hours, not sixty');
  assert.equal(mins(allowanceFor(last, H)), 180, 'so the ceiling tops out at three hours');
});

test('the chain is derived, so fixing an old entry fixes every day after it', () => {
  const asLogged = carryChain({ '2026-09-01': M(200) }, '2026-09-03', H);
  assert.equal(mins(asLogged['2026-09-02'].debt), 120, 'the overrun, capped');
  const corrected = carryChain({ '2026-09-01': M(20) }, '2026-09-03', H);
  assert.equal(corrected['2026-09-02'].debt, 0);
  assert.equal(mins(corrected['2026-09-02'].bonus), 27);
});

test('an empty history has no chain at all', () => {
  assert.deepEqual(carryChain({}, '2026-09-04', H), {});
});

test('the chain covers every calendar day in the window', () => {
  const chain = carryChain({ '2026-09-01': 0 }, '2026-09-10', H);
  assert.deepEqual(Object.keys(chain), dayRange('2026-09-01', '2026-09-10'));
});

// ------------------------------------------------------------------ the bands

test('a plain day inside the limit is one red band', () => {
  assert.deepEqual(entBands(M(25), NO_CARRY, H), [{ c: 'ent', ms: M(25) }]);
});

test('watching into banked time shows gold above red, and no debt tomorrow', () => {
  const bands = entBands(M(75), { debt: 0, bonus: M(30) }, H);
  assert.deepEqual(bands, [{ c: 'ent', ms: H }, { c: 'bonus', ms: M(15) }]);
  assert.deepEqual(carryForward(M(75), { debt: 0, bonus: M(30) }, H), { debt: 0, bonus: M(10) });
});

test('past the bank as well, the excess is the part that becomes debt', () => {
  const carry = { debt: 0, bonus: M(20) };
  const bands = entBands(M(100), carry, H);
  assert.deepEqual(bands, [
    { c: 'ent', ms: H }, { c: 'bonus', ms: M(20) }, { c: 'over', ms: M(20) },
  ]);
  assert.equal(carryForward(M(100), carry, H).debt, M(20), 'only the magenta travels');
});

test('carried debt is drawn first, and eats into the base limit', () => {
  const bands = entBands(M(50), { debt: M(20), bonus: 0 }, H);
  assert.deepEqual(bands, [
    { c: 'debt', ms: M(20) }, { c: 'ent', ms: M(40) }, { c: 'over', ms: M(10) },
  ]);
});

test('starting the day already past the limit makes every minute overtime', () => {
  assert.deepEqual(entBands(M(10), { debt: M(75), bonus: 0 }, H), [
    { c: 'debt', ms: M(75) }, { c: 'over', ms: M(10) },
  ]);
});

test('the bands always add up to what was charged — nothing invented, nothing lost', () => {
  const cases = [
    [M(0), NO_CARRY], [M(59), NO_CARRY], [H, NO_CARRY], [M(61), NO_CARRY],
    [M(45), { debt: M(10), bonus: 0 }], [M(45), { debt: 0, bonus: M(45) }],
    [M(500), { debt: M(120), bonus: 0 }], [M(1), { debt: M(1), bonus: 0 }],
  ];
  for (const [ent, carry] of cases) {
    const total = entBands(ent, carry, H).reduce((sum, b) => sum + b.ms, 0);
    assert.equal(total, chargedFor(ent, carry), `bands for ${mins(ent)}m`);
  }
});

test('with the limit switched off, nothing can be over it', () => {
  assert.deepEqual(entBands(M(200), NO_CARRY, 0), [{ c: 'ent', ms: M(200) }]);
});

// ----------------------------------------------------------------- the stack

test('the column stacks debt, entertainment, bonus, overtime, then the rest', () => {
  const parts = stackParts(
    { ent: M(90), work: M(30), menu: M(10) }, ['ent', 'work', 'menu'], H,
    { debt: M(15), bonus: 0 },
  );
  assert.deepEqual(parts.map((p) => [p.c, mins(p.ms), mins(p.from)]), [
    ['debt', 15, 0], ['ent', 45, 15], ['over', 45, 60], ['work', 30, 105], ['menu', 10, 135],
  ]);
});

test('a column with no carry looks exactly as it did before the economy existed', () => {
  const parts = stackParts({ ent: M(40), work: M(20) }, ['ent', 'work'], H);
  assert.deepEqual(parts, [
    { c: 'ent', ms: M(40), from: 0 },
    { c: 'work', ms: M(20), from: M(40) },
  ]);
});
