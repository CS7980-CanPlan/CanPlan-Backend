import { toCorpusFiles } from './build-corpus';

const line = {
  chunk_id: 'hlbc-85-handwash-steps',
  text: 'Wet your hands, use soap for 20 seconds.',
  category: 'hygiene',
  source: { title: 'Hand washing (HealthLink BC)', citation: 'File #85', url: 'https://example.com/handwash' },
};

describe('toCorpusFiles', () => {
  it('emits a body file named by chunk_id with the passage text', () => {
    const files = toCorpusFiles([line]);
    const body = files.find((f) => f.key === 'hlbc-85-handwash-steps.txt');
    expect(body?.body).toBe('Wet your hands, use soap for 20 seconds.');
  });

  it('emits a sibling .metadata.json with flattened metadataAttributes', () => {
    const files = toCorpusFiles([line]);
    const meta = files.find((f) => f.key === 'hlbc-85-handwash-steps.txt.metadata.json');
    expect(JSON.parse(meta!.body)).toEqual({
      metadataAttributes: {
        chunk_id: 'hlbc-85-handwash-steps',
        category: 'hygiene',
        title: 'Hand washing (HealthLink BC)',
        url: 'https://example.com/handwash',
        citation: 'File #85',
      },
    });
  });

  it('produces two files per passage', () => {
    expect(toCorpusFiles([line, { ...line, chunk_id: 'other' }])).toHaveLength(4);
  });
});
