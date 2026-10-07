import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isString } from './guards.ts';

describe('isString', () => {
  it('takes any text, the empty one included', () => {
    assert.equal(isString('photos/1.webp'), true);
    assert.equal(isString(''), true);
  });

  it('takes nothing else', () => {
    const others: [string, unknown][] = [
      ['null', null],
      ['undefined', undefined],
      ['a number', 1],
      ['a boolean', true],
      ['an object', {}],
      ['an array', []],
      ['a symbol', Symbol.iterator],
      ['a function', () => 'x'],
      ['a String object', new String('x')],
    ];

    for (const [what, value] of others) {
      assert.equal(isString(value), false, what);
    }
  });
});
