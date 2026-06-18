import {
  assignSk,
  categorySk,
  ENTITY,
  mediaSk,
  META_SK,
  NO_CATEGORY,
  padOrder,
  PROFILE_SK,
  progressSk,
  reportPk,
  stepSk,
  supporterPk,
  taskCategoryKey,
  taskPk,
  userLinkSk,
  userPk,
} from './keys';

describe('padOrder', () => {
  it('zero-pads to three digits', () => {
    expect(padOrder(1)).toBe('001');
    expect(padOrder(2)).toBe('002');
    expect(padOrder(10)).toBe('010');
    expect(padOrder(100)).toBe('100');
  });

  it('keeps padded orders lexicographically sortable', () => {
    const keys = [stepSk(3), stepSk(1), stepSk(10), stepSk(2)];
    expect([...keys].sort()).toEqual(['STEP#001', 'STEP#002', 'STEP#003', 'STEP#010']);
  });
});

describe('partition keys', () => {
  it('build the documented PK formats', () => {
    expect(userPk('u1')).toBe('USER#u1');
    expect(supporterPk('s1')).toBe('SUPPORTER#s1');
    expect(taskPk('t1')).toBe('TASK#t1');
    expect(reportPk('r1')).toBe('REPORT#r1');
  });
});

describe('sort keys', () => {
  it('build the documented SK formats', () => {
    expect(PROFILE_SK).toBe('#PROFILE');
    expect(META_SK).toBe('#META');
    expect(categorySk('c1')).toBe('CATEGORY#c1');
    expect(userLinkSk('u1')).toBe('USER#u1');
    expect(stepSk(1)).toBe('STEP#001');
    expect(assignSk('a1')).toBe('ASSIGN#a1');
    expect(progressSk('2026-06-15T10:00:00.000Z', 'e1')).toBe('PROGRESS#2026-06-15T10:00:00.000Z#e1');
    expect(mediaSk('m1')).toBe('MEDIA#m1');
  });
});

describe('taskCategoryKey', () => {
  it('joins owner and category into the taskCategoryIndex partition key', () => {
    expect(taskCategoryKey('o1', 'c1')).toBe('o1#c1');
    expect(taskCategoryKey('o1', NO_CATEGORY)).toBe('o1#NO_CATEGORY');
  });
});

describe('ENTITY discriminators', () => {
  it('match the entity-type strings stored on items', () => {
    expect(ENTITY.USER_PROFILE).toBe('UserProfile');
    expect(ENTITY.SUPPORT_LINK).toBe('SupportLink');
    expect(ENTITY.CATEGORY).toBe('Category');
    expect(ENTITY.TASK).toBe('Task');
    expect(ENTITY.TASK_STEP).toBe('TaskStep');
    expect(ENTITY.ASSIGNMENT).toBe('Assignment');
    expect(ENTITY.PROGRESS_EVENT).toBe('ProgressEvent');
    expect(ENTITY.MEDIA_ASSET).toBe('MediaAsset');
    expect(ENTITY.REPORT).toBe('Report');
  });
});
