/*
**	Nick Brandaleone - December 2019
**
**  This CDK program creates a working ECS cluster, container based application complete with App Mesh,
**  and a working CloudWatch Dashboard.
*/

import cdk = require('@aws-cdk/core');
import ecs = require('@aws-cdk/aws-ecs');
import ec2 = require('@aws-cdk/aws-ec2');
import ecr = require('@aws-cdk/aws-ecr');
import ecsPatterns = require("@aws-cdk/aws-ecs-patterns");
import appmesh = require('@aws-cdk/aws-appmesh');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import servicediscovery = require('@aws-cdk/aws-servicediscovery');
import cloudwatch = require('@aws-cdk/aws-cloudwatch');
import iam = require('@aws-cdk/aws-iam');

/******************************************************************************
*************************** Ec2AppMeshService *********************************
******************************************************************************/

export interface AppMeshServiceProps {
  cluster: ecs.Cluster;
  mesh: appmesh.IMesh;
  portNumber: number;
  applicationContainer: any
}

export class Ec2AppMeshService extends cdk.Construct {
  // Members of the class
  ecsService: ecs.Ec2Service;
  myServiceName: string;
  portNumber: number;
  taskDefinition: ecs.Ec2TaskDefinition;
  applicationContainer: ecs.ContainerDefinition;
  cwAgentContainer: ecs.ContainerDefinition;
  envoyContainer: ecs.ContainerDefinition;
  virtualService: appmesh.VirtualService;
  virtualNode: appmesh.VirtualNode;
  
  constructor(scope: cdk.Construct, id: string, props: AppMeshServiceProps) {
    super(scope, id);
    this.myServiceName = id;
    this.portNumber = props.portNumber;

    const appMeshRepository = ecr.Repository.fromRepositoryArn(this, 'app-mesh-envoy', 'arn:aws:ecr:us-west-2:840364872350:repository/aws-appmesh-envoy');
      const cluster = props.cluster;
      const mesh = props.mesh;
      const applicationContainer = props.applicationContainer;
  
    // We need to create a new ECS task role, which allows the task to push metrics into CloudWatch
    // and read from AppMesh for Envoy access.
    const taskIAMRole = new iam.Role(this, 'ECSTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });
    taskIAMRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy'));
    taskIAMRole.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AWSAppMeshEnvoyAccess'));
    /*
    taskIAMRole.addToPolicy(new iam.PolicyStatement({
      resources: ['*'],
      actions: ['lambda:InvokeFunction'] })); */
    
    this.taskDefinition = new ecs.Ec2TaskDefinition(this, `${this.myServiceName}-task-definition`, {
        taskRole: taskIAMRole,
        networkMode: ecs.NetworkMode.AWS_VPC,
        proxyConfiguration: new ecs.AppMeshProxyConfiguration({
          containerName: 'envoy',
          properties: {
            appPorts: [this.portNumber],
            proxyEgressPort: 15001,
            proxyIngressPort: 15000,
            ignoredUID: 1337,
            egressIgnoredIPs: [
              '169.254.170.2',
              '169.254.169.254'
            ]
          }
        }) 
      });

	  // Set-up application container, which was passed in from caller.
    this.applicationContainer = this.taskDefinition.addContainer('app', applicationContainer);
    this.applicationContainer.addPortMappings({
      containerPort: this.portNumber,
      hostPort: this.portNumber
    });

    this.envoyContainer = this.taskDefinition.addContainer('envoy', {
      //name: 'envoy',
      //image: appMeshRepository,
	  image: ecs.ContainerImage.fromEcrRepository(appMeshRepository, 'v1.12.1.1-prod'),
      essential: true,
      environment: {
        APPMESH_VIRTUAL_NODE_NAME: `mesh/${mesh.meshName}/virtualNode/${this.myServiceName}`,
        AWS_REGION: cdk.Stack.of(this).region,
		ENABLE_ENVOY_STATS_TAGS: '1',
		ENABLE_ENVOY_DOG_STATSD: '1',
		ENVOY_LOG_LEVEL: 'debug'
      },
      healthCheck: {
        command: [
          'CMD-SHELL',
          'curl -s http://localhost:9901/server_info | grep state | grep -q LIVE'
        ],
        startPeriod: cdk.Duration.seconds(10),
        interval: cdk.Duration.seconds(5),
        timeout: cdk.Duration.seconds(2),
        retries: 3
      },
      memoryLimitMiB: 128,
      user: '1337',
      logging: new ecs.AwsLogDriver({
        streamPrefix: `${this.myServiceName}-envoy`
      })
    });
	
// How to use Parameter Store or Secrets Manager
/*   const stringValue = ssm.StringParameter.fromStringParameterAttributes(this, 'MyValue', {
       parameterName: 'AmazonCloudWatch-linux',
       'version' can be specified but is optional.
		}).stringValue;	

// Get latest version or specified version of plain string attribute
const latestStringToken = ssm.StringParameter.valueForStringParameter(
    this, 'my-plain-parameter-name');      // latest version
const versionOfStringToken = ssm.StringParameter.valueForStringParameter(
    this, 'my-plain-parameter-name', 1);   // version 1

// Get specified version of secure string attribute
const secureStringToken = ssm.StringParameter.valueForSecureStringParameter(
    this, 'my-secure-parameter-name', 1);   // must specify version	
		
// Secrets Manager			
    const secret = sm.Secret.fromSecretAttributes(this, "ImportedSecret", {
      secretArn:
        "arn:aws:secretsmanager:<region>:<account-id-number>:secret:<secret-name>-<random-6-characters>"
      // If the secret is encrypted using a KMS-hosted CMK, either import or reference that key:
      // encryptionKey: ...
    });	
*/
		
		// Adding CloudWatch logging container.
		// This container listends on StatsD port, and forwards to CloudWatch
    this.cwAgentContainer = this.taskDefinition.addContainer('cloudwatch-agent', {
      image: ecs.ContainerImage.fromRegistry("amazon/cloudwatch-agent:latest"),
      memoryLimitMiB: 512,
      essential: false,
          logging: new ecs.AwsLogDriver({
            streamPrefix: `${this.myServiceName}-cwagent`
          }),
      environment: { 
        CW_CONFIG_CONTENT: '{ "logs": { "metrics_collected": {"emf": {} }}, "metrics": { "metrics_collected": { "statsd": {}}}}'
        /* 
        '{"agent": {"omit_hostname": true, \
        "region": "us-west-2", \
        "logfile": "/opt/aws/amazon-cloudwatch-agent/logs/amazon-cloudwatch-agent.log", \
              "debug": true}, \
        "logs": { "metrics_collected": { "emf": {} } }, \
        "metrics": { "metrics_collected": {"statsd": \
        {"service_address":":8125","metrics_collection_interval": 10, \
              "metrics_aggregation_interval": 60 }}}}'
      */
      }
	  });  

	// Set start-up order of containers
    this.applicationContainer.addContainerDependencies(
		{
      	  container: this.envoyContainer,
		  condition: ecs.ContainerDependencyCondition.HEALTHY
		},
		{
      	  container: this.cwAgentContainer,
	  	  condition: ecs.ContainerDependencyCondition.START
    	} 
	); 
	
  this.ecsService = new ecs.Ec2Service(this, `${this.myServiceName}-service`, {
    cluster: cluster,
    desiredCount: 2,
    taskDefinition: this.taskDefinition,
    cloudMapOptions: {
      dnsRecordType: servicediscovery.DnsRecordType.A,
      dnsTtl: cdk.Duration.seconds(10),
      failureThreshold: 2,
      name: this.myServiceName
    }
  });
	
  // Create a virtual node for the name service
  this.virtualNode = new appmesh.VirtualNode(this, `${this.myServiceName}-virtual-node`, {
    mesh: mesh,
    virtualNodeName: this.myServiceName,
    cloudMapService: this.ecsService.cloudMapService,
    listener: {
      portMapping: {
        port: this.portNumber,
        protocol: appmesh.Protocol.HTTP,
      },
      healthCheck: {
        healthyThreshold: 2,
	  interval: cdk.Duration.seconds(5), // minimum
        path: '/',
        port: this.portNumber,
        protocol: appmesh.Protocol.HTTP,
	  timeout: cdk.Duration.seconds(2), // minimum
        unhealthyThreshold: 2
      }
    },
  });

  // Create virtual service to make the virtual node accessible
  this.virtualService = new appmesh.VirtualService(this, `${this.myServiceName}-virtual-service`, {
    mesh: mesh,
    virtualNode: this.virtualNode,
    virtualServiceName: `${this.myServiceName}.internal`
   // `${this.myServiceName}.${cluster.defaultCloudMapNamespace.namespaceName}`
  });
}  // end of Constructor
  
  // Connect this mesh enabled service to another mesh enabled service.
  // This adjusts the security groups for both services so that they
  // can talk to each other. Also adjusts the virtual node for this service
  // so that its Envoy intercepts traffic that can be handled by the other
  // service's virtual service.
  connectToMeshService(appMeshService: Ec2AppMeshService) {
    var trafficPort = new ec2.Port({
      protocol: ec2.Protocol.TCP,
      fromPort: appMeshService.portNumber,
      toPort: 3000,
	  stringRepresentation: 'Inbound traffic from the app mesh enabled'
    });

    // Adjust security group to allow traffic from this app mesh enabled service
    // to the other app mesh enabled service.
    this.ecsService.connections.allowTo(appMeshService.ecsService, trafficPort, `Inbound traffic from the app mesh enabled ${this.myServiceName}`);

    // Now adjust this app mesh service's virtual node to add a backend
    // that is the other service's virtual service
    this.virtualNode.addBackends(appMeshService.virtualService);
  }
}

/******************************************************************************
*************************** MyDashboard ***************************************
******************************************************************************/

export interface MyDashboardProps {
	ecsCluster: ecs.Cluster,
	greeterService: Ec2AppMeshService,
	greetingService: Ec2AppMeshService,
	nameService: Ec2AppMeshService,
	loadBalancer: elbv2.ApplicationLoadBalancer,
	targetGroup: elbv2.ApplicationTargetGroup
}

export class MyDashboard extends cdk.Construct{
	dashboard: cloudwatch.Dashboard;
	
  constructor(scope: cdk.Construct, id: string, props: MyDashboardProps) {
    super(scope, id);
		
    this.dashboard = new cloudwatch.Dashboard(this, "appmesh-dashboard");
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# AppMesh Envoy Telemetry Dashboard',
        width: 24
      })
    );

    this.dashboard.addWidgets(new cloudwatch.GraphWidget({
      title: "greeter Task Count",
      width: 8,
      leftYAxis: {
        min: 0
      },
      left: [new cloudwatch.Metric({
        namespace: "AWS/ECS",
        metricName: 'CPUUtilization',
        label: "Running Tasks",
        dimensions: {
          ServiceName: props.greeterService.ecsService.serviceName,
          ClusterName: props.ecsCluster.clusterName
        },
        statistic: 'n',
        period: cdk.Duration.minutes(1)
      })]
    }),
      new cloudwatch.GraphWidget({
        title: "ReqCountPerTarget",
        left: [
					new cloudwatch.Metric({
	          namespace: "AWS/ApplicationELB",
	          metricName: "RequestCountPerTarget",
						label: "ALB RequestCountPerTarget",
	          dimensions: {
	            TargetGroup: props.targetGroup.targetGroupFullName,
	            LoadBalancer: props.loadBalancer.loadBalancerFullName
	          },
	          color: '#98df8a',
	          statistic: 'sum',
						unit: cloudwatch.Unit.COUNT,
	          period: cdk.Duration.minutes(1)
          })
        ],
        stacked: true
      }),
      new cloudwatch.GraphWidget({ 
	      title: "greeter Task CPU/MEM",
	      width: 8,
	      leftYAxis: {
	        min: 0
	      },
	      left: [
	        new cloudwatch.Metric({
	          namespace: "AWS/ECS",
	          metricName: 'CPUUtilization',
	          label: "CPUUtilization",
	          dimensions: {
	            ServiceName: props.greeterService.ecsService.serviceName,
	            ClusterName: props.ecsCluster.clusterName
	          },
	          statistic: 'avg',
	          period: cdk.Duration.minutes(1)
	        })],
	      right: [new cloudwatch.Metric({
	        namespace: "AWS/ECS",
	        metricName: 'MemoryUtilization',
	        label: "MemoryUtilization",
	        dimensions: {
	          ServiceName: props.greeterService.ecsService.serviceName,
	          ClusterName: props.ecsCluster.clusterName
	        },
	        statistic: 'avg',
	        period: cdk.Duration.minutes(1)
	      })]
      }),
      new cloudwatch.GraphWidget({
        title: "TargetResponseTime (P95)",
        left: [new cloudwatch.Metric({
          namespace: "AWS/ApplicationELB",
          metricName: "TargetResponseTime",
          dimensions: {
            TargetGroup: props.targetGroup.targetGroupFullName,
            LoadBalancer: props.loadBalancer.loadBalancerFullName
          },
          color: '#2ca02c',
          statistic: 'p95',
          period: cdk.Duration.minutes(1)
        })
        ],
        stacked: true
      })
    );
		
	this.dashboard.addWidgets(
	    buildEnvoyWidget('envoy_http_downstream_rq_xx', 'greeter'),      // Each Widget add creates a new column
	    buildEnvoyWidget('envoy_http_downstream_rq_xx', 'greeting'),
		buildEnvoyWidget('envoy_http_downstream_rq_xx', 'name'),
	);
		
    // A helper function to assist with creating Envoy stats
	function buildEnvoyWidget(metricName: string, dim: string, options?: cloudwatch.MetricOptions){
	    return new cloudwatch.GraphWidget({
	        title: metricName,
	        left: [new cloudwatch.Metric({
	            namespace: 'CWAgent',
	            metricName: metricName,
	            dimensions: {
	 				 	'appmesh.mesh': 'greeting-app-mesh',
						'metric_type': 'counter',
						'envoy.http_conn_manager_prefix': 'ingress',
						'appmesh.virtual_node': dim,
						'envoy.response_code_class': '2'
	            },
			    label: metricName,
	            statistic: 'avg',
			    period: cdk.Duration.minutes(1),
	            unit: cloudwatch.Unit.COUNT,
	        })],
			right: [new cloudwatch.Metric({
                namespace: "AWS/ECS",
                metricName: 'MemoryUtilization',
                label: "MemoryUtilization",
                dimensions: {
	 				 	'appmesh.mesh': 'greeting-app-mesh',
						'metric_type': 'counter',
						'envoy.http_conn_manager_prefix': 'egress',
						'appmesh.virtual_node': dim,
						'envoy.response_code_class': '2'
                },
                statistic: 'avg',
                period: cdk.Duration.minutes(1)
            })]
	    })
	};
		// TODO
		// Export Dashboard name / Print out Dashboard name
				// console.log(this.dashboard.toString());
		// end of Dashboard class
    }
}

/******************************************************************************
*************************** AppmeshBlogStack **********************************
******************************************************************************/

/* This stack is getting TOO BIG.  Perhaps breaking this up? Using Nested Stacks,
	or extend Class.App */
export class AppmeshBlogStack extends cdk.Stack {
	cluster: ecs.Cluster;
	nameService: Ec2AppMeshService;
	greeterService: Ec2AppMeshService;
	greetingService: Ec2AppMeshService;
	externalLB: elbv2.ApplicationLoadBalancer;
	dashboard: MyDashboard;
	
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.Vpc(this, 'GreetingVpc', { maxAzs: 2 });

    // Create an ECS cluster and CloudMap namespace
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc: vpc,
      defaultCloudMapNamespace: {
        name: 'internal',
        type: servicediscovery.NamespaceType.DNS_PRIVATE,
		vpc: vpc
      } 
    });

	// Create a CloudMap namespace 
	/* const namespace = new servicediscovery.PrivateDnsNamespace(this, 'internal-namespace', {
		vpc: vpc,
		name: 'internal'
	}); 
	const svcnamespace = namespace.createService('Svc'); */
	
    // Create an App Mesh
    const mesh = new appmesh.Mesh(this, 'app-mesh', {
      meshName: 'greeting-app-mesh',
      //egressFilter: appmesh.MeshFilterType.DROP_ALL
    });
	
    // Add capacity to cluster
    this.cluster.addCapacity('greeter-capacity', {
      instanceType: new ec2.InstanceType('t3.large'),
      minCapacity: 3,
      maxCapacity: 3,
	  //keyName: 'aws-key',		// SSH-KEY to access instances
    });

    const healthCheck = {
      command: [
        'curl localhost:3000'
      ],
      startPeriod: cdk.Duration.seconds(10),
      interval: cdk.Duration.seconds(5),
      timeout: cdk.Duration.seconds(2),
      retries: 3
    };

		// Create three ECS services (greeter, greeting, name)
    this.nameService = new Ec2AppMeshService(this, 'name', {
      cluster: this.cluster,
      mesh: mesh,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/name'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-name'
        }),
        environment: {
          PORT: '3000'
        }
      }
    });

    this.greetingService = new Ec2AppMeshService(this, 'greeting', {
      cluster: this.cluster,
      mesh: mesh,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/greeting'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-greeting'
        }),
        environment: {
          PORT: '3000'
        }
      }
    });

    this.greeterService = new Ec2AppMeshService(this, 'greeter', {
      cluster: this.cluster,
      mesh: mesh,
      portNumber: 3000,
      applicationContainer: {
        image: ecs.ContainerImage.fromRegistry('nathanpeck/greeter'),
        healthCheck: healthCheck,
        memoryLimitMiB: 128,
        logging: new ecs.AwsLogDriver({
          streamPrefix: 'app-mesh-greeter'
        }),
        environment: {
          GREETING_URL: 'http://greeting.internal:3000',
          NAME_URL: 'http://name.internal:3000',
          PORT: '3000'
        }
      }
    });

		// Wire up Security Groups and App Mesh nodes/backends
    this.greeterService.connectToMeshService(this.nameService);
    this.greeterService.connectToMeshService(this.greetingService);

    // Last but not least setup an internet facing load balancer for
    // exposing the public facing greeter service to the public.
    this.externalLB = new elbv2.ApplicationLoadBalancer(this, 'external', {
      vpc: vpc,
      internetFacing: true
    });

    const externalListener = this.externalLB.addListener('PublicListener', { port: 80, open: true });

    const tg = externalListener.addTargets('greeter', {
      port: 80,
      targets: [this.greeterService.ecsService],
	  //targetType: elasticloadbalancingv2.TargetType.IP // Fargate
    });
		// Create CloudWatch Dashboard
		
		this.dashboard = new MyDashboard(this, 'cloudwatch-dashboard', {
			ecsCluster: this.cluster,
			greeterService: this.greeterService,
			greetingService: this.greetingService,
			nameService: this.nameService,
			loadBalancer: this.externalLB,
			targetGroup: tg
		});
		
		// Send LoadBalancer DNS name to output
    new cdk.CfnOutput(this, 'ExternalDNS', {
      exportName: 'greeter-app-external',
      value: this.externalLB.loadBalancerDnsName
    });
  }
}