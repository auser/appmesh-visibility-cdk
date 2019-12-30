#!/usr/bin/env node
import 'source-map-support/register';
import cdk = require('@aws-cdk/core');
import { AppmeshBlogStack } from '../lib/appmesh_blog-stack';

const app = new cdk.App();

new AppmeshBlogStack(app, 'AppMeshBlogECS', {
    env: {region: "us-west-2"},
});

/*
new AppmeshBlogStack(app, "AppMeshBlogFargate", {
    env: {region: "us-west-2"},
    setFargate: true
});
*/