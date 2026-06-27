import {
  categorySk,
  DEFAULT_CATEGORY_COLOR,
  DEFAULT_CATEGORY_NAME,
  ENTITY,
  isDefaultCategoryName,
  mediaSk,
  META_SK,
  parseInstanceId,
  PROFILE_SK,
  reportPk,
  stepSk,
  supporterPk,
  TASK_INSTANCE_PREFIX,
  taskAssignmentSk,
  taskCategoryKey,
  taskInstanceId,
  taskInstanceSk,
  taskInstanceSkFromId,
  taskInstanceStepPrefix,
  taskInstanceStepSk,
  taskPk,
  userLinkSk,
  userPk,
} from './keys';

describe('stepSk', () => {
  it('keys a TaskStep by its stable stepId, not by order', () => {
    expect(stepSk('abc-123')).toBe('STEP#abc-123');
  });
});

describe('default category name', () => {
  it('matches "No Category" case-insensitively after trimming', () => {
    expect(DEFAULT_CATEGORY_NAME).toBe('No Category');
    expect(DEFAULT_CATEGORY_COLOR).toBe('#64748B');
    expect(isDefaultCategoryName('No Category')).toBe(true);
    expect(isDefaultCategoryName('  no category  ')).toBe(true);
    expect(isDefaultCategoryName('NO CATEGORY')).toBe(true);
    expect(isDefaultCategoryName('Hygiene')).toBe(false);
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
    expect(stepSk('s1')).toBe('STEP#s1');
    expect(mediaSk('m1')).toBe('MEDIA#m1');
  });
});

describe('scheduling sort keys', () => {
  it('build the TaskAssignment / TaskInstance / TaskInstanceStep SK formats', () => {
    expect(taskAssignmentSk('a1')).toBe('TASK_ASSIGNMENT#a1');
    expect(taskInstanceSk('2026-07-01', '09:00', 'a1')).toBe(
      'TASK_INSTANCE#2026-07-01#09:00#a1',
    );
    expect(taskInstanceId('a1', '2026-07-01', '09:00')).toBe('a1#2026-07-01#09:00');
    expect(taskInstanceSkFromId('a1#2026-07-01#09:00')).toBe('TASK_INSTANCE#2026-07-01#09:00#a1');
    expect(taskInstanceStepSk('a1#2026-07-01#09:00', 's1')).toBe(
      'TASK_INSTANCE_STEP#a1#2026-07-01#09:00#STEP#s1',
    );
    expect(taskInstanceStepPrefix('a1#2026-07-01#09:00')).toBe(
      'TASK_INSTANCE_STEP#a1#2026-07-01#09:00#STEP#',
    );
  });

  it('keeps TaskInstanceStep rows out of a begins_with(TASK_INSTANCE#) instance query', () => {
    // Instance SKs are `TASK_INSTANCE#<date>#…`; step SKs are `TASK_INSTANCE_STEP#…`. The
    // 14th char differs (`#` vs `_`), so a date-range instance query never returns step rows.
    expect(taskInstanceStepSk('a1#2026-07-01#09:00', 's1').startsWith(TASK_INSTANCE_PREFIX)).toBe(
      false,
    );
  });

  it('parses a composite instanceId, rejecting malformed ids', () => {
    expect(parseInstanceId('a1#2026-07-01#09:00')).toEqual({
      assignmentId: 'a1',
      scheduledDate: '2026-07-01',
      scheduledTime: '09:00',
    });
    expect(parseInstanceId('a1#2026-07-01')).toBeNull();
    expect(parseInstanceId('nope')).toBeNull();
  });
});

describe('taskCategoryKey', () => {
  it('joins owner and category into the taskCategoryIndex partition key', () => {
    expect(taskCategoryKey('o1', 'c1')).toBe('o1#c1');
    expect(taskCategoryKey('o1', 'cat-9')).toBe('o1#cat-9');
  });
});

describe('ENTITY discriminators', () => {
  it('match the entity-type strings stored on items', () => {
    expect(ENTITY.USER_PROFILE).toBe('UserProfile');
    expect(ENTITY.SUPPORT_LINK).toBe('SupportLink');
    expect(ENTITY.CATEGORY).toBe('Category');
    expect(ENTITY.TASK).toBe('Task');
    expect(ENTITY.TASK_STEP).toBe('TaskStep');
    expect(ENTITY.TASK_ASSIGNMENT).toBe('TaskAssignment');
    expect(ENTITY.TASK_INSTANCE).toBe('TaskInstance');
    expect(ENTITY.TASK_INSTANCE_STEP).toBe('TaskInstanceStep');
    expect(ENTITY.MEDIA_ASSET).toBe('MediaAsset');
    expect(ENTITY.TASK_MEDIA_CLEANUP).toBe('TaskMediaCleanup');
    expect(ENTITY.REPORT).toBe('Report');
  });
});
