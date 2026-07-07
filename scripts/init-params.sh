#!/bin/bash
set -e

API_URL=$(aws cloudformation describe-stacks --stack-name ApiStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)

COGNITO_DOMAIN=$(aws cloudformation describe-stacks --stack-name IdentityStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolDomainUrl`].OutputValue' --output text)

CLIENT_ID=$(aws cloudformation describe-stacks --stack-name IdentityStack \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolClientId`].OutputValue' --output text)

echo "API URL:        $API_URL"
echo "Cognito Domain: $COGNITO_DOMAIN"
echo "Client ID:      $CLIENT_ID"
