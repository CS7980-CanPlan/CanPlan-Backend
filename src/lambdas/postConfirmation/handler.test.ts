import { handler } from './handler';
import { cognito } from '../../shared/cognito';
import { AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';

jest.mock('../../shared/cognito', () => ({
  cognito: { send: jest.fn() },
  PRIMARY_USER_GROUP: 'PrimaryUser',
}));

const mockSend = cognito.send as jest.Mock;

beforeEach(() => mockSend.mockResolvedValue({}));
afterEach(() => jest.clearAllMocks());

function event(
  triggerSource: string,
  overrides: Partial<PostConfirmationTriggerEvent> = {},
): PostConfirmationTriggerEvent {
  return {
    version: '1',
    region: 'ca-central-1',
    userPoolId: 'ca-central-1_pool123',
    userName: 'sam',
    triggerSource,
    callerContext: { awsSdkVersion: '1', clientId: 'client123' },
    request: { userAttributes: { email: 'sam@example.com' } },
    response: {},
    ...overrides,
  } as PostConfirmationTriggerEvent;
}

describe('postConfirmation handler', () => {
  it('adds a confirmed sign-up user to PrimaryUser and echoes the event back', async () => {
    const input = event('PostConfirmation_ConfirmSignUp');
    const result = await handler(input);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0][0] as AdminAddUserToGroupCommand;
    expect(command).toBeInstanceOf(AdminAddUserToGroupCommand);
    expect(command.input).toEqual({
      UserPoolId: 'ca-central-1_pool123',
      Username: 'sam',
      GroupName: 'PrimaryUser',
    });
    expect(result).toBe(input);
  });

  it('does not call Cognito for other trigger sources', async () => {
    const result = await handler(event('PostConfirmation_ConfirmForgotPassword'));
    expect(mockSend).not.toHaveBeenCalled();
    expect(result.triggerSource).toBe('PostConfirmation_ConfirmForgotPassword');
  });

  it('does not fail the confirmation flow when the user is already in the group (retry)', async () => {
    mockSend.mockRejectedValueOnce(new Error('User already in group'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const input = event('PostConfirmation_ConfirmSignUp');

    const result = await handler(input);

    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalled();
    expect(result).toBe(input);
    errSpy.mockRestore();
  });
});
