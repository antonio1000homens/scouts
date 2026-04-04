import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});
const secretCache = new Map();

async function fetchSecret(parameterName) {
  if (secretCache.has(parameterName)) {
    return secretCache.get(parameterName);
  }

  const response = await ssmClient.send(new GetParameterCommand({
    Name: parameterName,
    WithDecryption: true,
  }));
  const value = response.Parameter?.Value;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`SSM parameter ${parameterName} is empty or missing`);
  }
  secretCache.set(parameterName, value);
  return value;
}

export async function getRequiredSecret(nameEnvVar) {
  const parameterName = (process.env[nameEnvVar] || '').trim();
  if (!parameterName) {
    throw new Error(`${nameEnvVar} is missing in environment variables`);
  }
  return fetchSecret(parameterName);
}

export async function getOptionalSecret(nameEnvVar, fallback = '') {
  const parameterName = (process.env[nameEnvVar] || '').trim();
  if (!parameterName) {
    return fallback;
  }
  return fetchSecret(parameterName);
}
