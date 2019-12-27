#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { AppmeshBlogStack } from '../lib/appmesh_blog-stack';

const app = new cdk.App();
new AppmeshBlogStack(app, 'AppmeshBlogStack');
