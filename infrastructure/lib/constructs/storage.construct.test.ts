import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Storage } from './storage.construct';

describe('Storage construct', () => {
  it('expires generated report PDFs after one day while leaving saved JSON reports durable', () => {
    const stack = new Stack(new App(), 'StorageTestStack');
    new Storage(stack, 'Storage', { envName: 'test', isDestroyable: false });
    const template = Template.fromStack(stack);
    const bucket = Object.values(template.findResources('AWS::S3::Bucket'))[0];
    const rules = bucket.Properties.LifecycleConfiguration.Rules;

    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          Id: 'expire-generated-report-pdf-cache',
          Prefix: 'report-pdf-cache/',
          ExpirationInDays: 1,
          Status: 'Enabled',
        }),
      ]),
    );
    expect(rules).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ Prefix: 'reports/' })]),
    );
  });
});
