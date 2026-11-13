import { describe, expect, it } from 'vitest';

import { insertMention, mentionQuery, splitMentions, suggest } from './mentions';

describe('mentionQuery', () => {
  it('finds the @word being typed', () => {
    expect(mentionQuery('Thanks @An', 10)).toEqual({ start: 7, query: 'An' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
  });

  it('allows a space inside a name being typed', () => {
    expect(mentionQuery('hi @Ana Lo', 10)).toEqual({ start: 3, query: 'Ana Lo' });
  });

  it('ignores email addresses and finished lines', () => {
    expect(mentionQuery('mail ana@example.test', 21)).toBeNull();
    expect(mentionQuery('@Ana\nnext', 9)).toBeNull();
    expect(mentionQuery('no mention here', 15)).toBeNull();
  });
});

describe('suggest', () => {
  const names = ['Ana Lopez', 'Ben', 'Hanna', 'Banana Bob'];
  it('puts names that start with the query first', () => {
    expect(suggest(names, 'an')).toEqual(['Ana Lopez', 'Hanna', 'Banana Bob']);
    expect(suggest(names, '')).toEqual(names);
  });
});

describe('insertMention', () => {
  it('replaces the query with the full name and a space', () => {
    expect(insertMention('Thanks @An!', 7, 10, 'Ana Lopez')).toEqual({ text: 'Thanks @Ana Lopez !', caret: 18 });
  });
});

describe('splitMentions', () => {
  it('marks known names, longest first, case-insensitively', () => {
    expect(splitMentions('@ana lopez and @Ben, look', ['Ana', 'Ana Lopez', 'Ben'])).toEqual([
      { text: '@ana lopez', mention: true },
      { text: ' and ', mention: false },
      { text: '@Ben', mention: true },
      { text: ', look', mention: false },
    ]);
  });

  it('leaves unknown names, longer words and email addresses alone', () => {
    expect(splitMentions('@Benjamin and x@Ben.test', ['Ben'])).toEqual([{ text: '@Benjamin and x@Ben.test', mention: false }]);
  });
});
