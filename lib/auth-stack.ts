import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'path';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  readonly accountId: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly administratorGroupArn: string;
  public readonly analystGroupArn: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // DynamoDB table for tracking authentication attempts
    const authAttemptsTable = new dynamodb.Table(this, 'AuthAttemptsTable', {
      tableName: `email-archive-auth-attempts-${props.accountId}`,
      partitionKey: {
        name: 'username',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      timeToLiveAttribute: 'ttl',
    });

    // Pre-authentication Lambda trigger for account lockout logic
    const preAuthLambda = new lambdaNodejs.NodejsFunction(this, 'PreAuthenticationTrigger', {
      functionName: `email-archive-pre-auth-${props.accountId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'pre-auth', 'index.ts'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Pre-authentication trigger: checks lockout status and tracks auth attempts (5 failures -> 15 min lockout)',
      environment: {
        AUTH_ATTEMPTS_TABLE: authAttemptsTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: ['@aws-sdk/client-dynamodb'],
      },
    });

    // Post-authentication Lambda trigger to reset counter on success
    const postAuthLambda = new lambdaNodejs.NodejsFunction(this, 'PostAuthenticationTrigger', {
      functionName: `email-archive-post-auth-${props.accountId}`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'handler',
      entry: path.join(__dirname, '..', 'lambda', 'post-auth', 'index.ts'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      description: 'Post-authentication trigger: resets failed attempt counter on successful login',
      environment: {
        AUTH_ATTEMPTS_TABLE: authAttemptsTable.tableName,
      },
      logRetention: logs.RetentionDays.ONE_YEAR,
      bundling: {
        forceDockerBundling: false,
        externalModules: ['@aws-sdk/client-dynamodb'],
      },
    });

    // Grant DynamoDB read/write permissions to both Lambda functions
    authAttemptsTable.grantReadWriteData(preAuthLambda);
    authAttemptsTable.grantReadWriteData(postAuthLambda);

    // Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'EmailArchiveUserPool', {
      userPoolName: `email-archive-user-pool-${props.accountId}`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lambdaTriggers: {
        preAuthentication: preAuthLambda,
        postAuthentication: postAuthLambda,
      },
    });

    // User Pool Client (SPA — no client secret, Authorization Code with PKCE)
    this.userPoolClient = new cognito.UserPoolClient(this, 'EmailArchiveUserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: `email-archive-spa-client-${props.accountId}`,
      generateSecret: false,
      authFlows: {
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
      },
      accessTokenValidity: cdk.Duration.minutes(30),
      idTokenValidity: cdk.Duration.minutes(30),
      refreshTokenValidity: cdk.Duration.hours(24),
      preventUserExistenceErrors: true,
    });

    // Create groups: Administrator and Analyst
    const administratorGroup = new cognito.CfnUserPoolGroup(this, 'AdministratorGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Administrator',
      description: 'Full system configuration and data access',
      precedence: 1,
    });

    const analystGroup = new cognito.CfnUserPoolGroup(this, 'AnalystGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'Analyst',
      description: 'Search and read-only access to email data',
      precedence: 2,
    });

    // Construct group ARNs for cross-stack references
    this.administratorGroupArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}/group/Administrator`;
    this.analystGroupArn = `arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${this.userPool.userPoolId}/group/Analyst`;

    // Outputs for cross-stack references
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'EmailArchive-UserPoolId',
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'EmailArchive-UserPoolClientId',
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: 'EmailArchive-UserPoolArn',
      description: 'Cognito User Pool ARN',
    });

    new cdk.CfnOutput(this, 'AuthAttemptsTableName', {
      value: authAttemptsTable.tableName,
      exportName: 'EmailArchive-AuthAttemptsTableName',
      description: 'DynamoDB table for tracking authentication attempts',
    });
  }
}
