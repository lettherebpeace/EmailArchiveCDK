// Application configuration from environment variables

export const config = {
  apiUrl: import.meta.env.VITE_API_URL || 'http://localhost:3000',
  cognito: {
    userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID || '',
    clientId: import.meta.env.VITE_COGNITO_CLIENT_ID || '',
    region: import.meta.env.VITE_AWS_REGION || 'us-east-1',
  },
} as const;
