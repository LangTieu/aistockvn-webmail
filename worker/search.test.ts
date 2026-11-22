import { describe, expect, it } from 'vitest';
import { buildFtsQuery } from './search';

describe('buildFtsQuery', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(buildFtsQuery('')).toBeNull();
    expect(buildFtsQuery('   ')).toBeNull();
    expect(buildFtsQuery('\t\n\r ')).toBeNull();
  });

  it('wraps a single term in double quotes', () => {
    expect(buildFtsQuery('invoice')).toBe('"invoice"');
    expect(buildFtsQuery('  receipt  ')).toBe('"receipt"');
  });

  it('joins multi-word input with AND of quoted terms', () => {
    expect(buildFtsQuery('quarterly report 2026')).toBe(
      '"quarterly" AND "report" AND "2026"'
    );
    expect(buildFtsQuery('  project   alpha\tupdate  ')).toBe(
      '"project" AND "alpha" AND "update"'
    );
  });

  it('neutralises FTS5 special characters and operators', () => {
    // Embedded double quotes are escaped by doubling
    expect(buildFtsQuery('say "hello"')).toBe('"say" AND """hello"""');

    // Wildcards, boost, parens, column filters, negation/prefix minus
    expect(buildFtsQuery('subject:urgent* ^2 (test) -spam')).toBe(
      '"urgent" AND "2" AND "test" AND "spam"'
    );

    // Tokens containing only operator characters are dropped
    expect(buildFtsQuery('* ^ ( ) : - + ""')).toBeNull();
    expect(buildFtsQuery('valid - * (query)')).toBe('"valid" AND "query"');
  });

  it('preserves Unicode and Vietnamese terms with diacritics', () => {
    expect(buildFtsQuery('Hóa đơn điện tử tháng 11')).toBe(
      '"Hóa" AND "đơn" AND "điện" AND "tử" AND "tháng" AND "11"'
    );
    expect(buildFtsQuery('Nguyễn Văn A - Báo cáo: quý*')).toBe(
      '"Nguyễn" AND "Văn" AND "A" AND "Báo" AND "cáo" AND "quý"'
    );
  });
});
