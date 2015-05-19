/*
		Copyright 2014-2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

    Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at

        http://aws.amazon.com/asl/

    or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License. 
 */


/* 
 * May 2015
 * Derivative created by HP, to leverage and extend the function framework to provide automatic loading from S3, via Lambda, to the HP Vertica Analytic Database platform.
 */



/**
 * Ask questions of the end user via STDIN and then setup the dynamo DB table
 * entry for the configuration when done
 */
var pjson = require('./package.json');
var readline = require('readline');
var aws = require('aws-sdk');
require('./constants');
var common = require('./common');
var async = require('async');
var uuid = require('node-uuid');
var dynamoDB;
var kmsCrypto = require('./kmsCrypto');
var setRegion;

dynamoConfig = {
	TableName : configTable,
	Item : {
		currentBatch : {
			S : uuid.v4()
		},
		version : {
			S : pjson.version
		},
		loadClusters : {
			L : [ {
				M : {

				}
			} ]
		}
	}
};

/* configuration of question prompts and config assignment */
var rl = readline.createInterface({
	input : process.stdin,
	output : process.stdout
});

var qs = [];

q_region = function(callback) {
	rl.question('Enter the Region for the Configuration (Reqd.) > ', function(answer) {
		if (common.blank(answer) !== null) {
			common.validateArrayContains([ "ap-northeast-1", "ap-southeast-1",
					"ap-southeast-2", "eu-central-1", "eu-west-1", "sa-east-1",
					"us-east-1", "us-west-1", "us-west-2" ], answer
					.toLowerCase(), rl);

			setRegion = answer.toLowerCase();

			// configure dynamo db and kms for the correct region
			dynamoDB = new aws.DynamoDB({
				apiVersion : '2012-08-10',
				region : setRegion
			});
			kmsCrypto.setRegion(setRegion);

			callback(null);
		}
	});
};

q_s3Prefix = function(callback) {
	rl.question('Enter the S3 Bucket & Prefix to watch for files (Reqd.) > ', function(
			answer) {
		common.validateNotNull(answer,
				'You Must Provide an S3 Bucket Name, and optionally a Prefix',
				rl);

		// setup prefix to be * if one was not provided
		var stripped = answer.replace(new RegExp('s3://', 'g'), '');
		var elements = stripped.split("/");
		var setPrefix = undefined;

		if (elements.length === 1) {
			// bucket only so use "bucket" alone
			setPrefix = elements[0];
		} else {
			// right trim "/"
			setPrefix = stripped.replace(/\/$/, '');
		}

		dynamoConfig.Item.s3Prefix = {
			S : setPrefix
		};

		callback(null);
	});
};

q_filenameFilter = function(callback) {
	rl.question('Enter a Filename Filter Regex > ', function(answer) {
		if (common.blank(answer) !== null) {
			dynamoConfig.Item.filenameFilterRegex = {
				S : answer
			};
		}
		callback(null);
	});
};

q_clusterEndpoint = function(callback) {
	rl.question('Enter the Vertica Cluster Endpoint (Public IP or DNS name) (Reqd.) > ', function(answer) {
		common.validateNotNull(answer, 'You Must Provide a Vertica Cluster Endpoint',
				rl);
		dynamoConfig.Item.loadClusters.L[0].M.clusterEndpoint = {
			S : answer
		};
		callback(null);
	});
};

q_clusterPort = function(callback) {
	rl.question('Enter the Vertica Cluster Port [5433]> ', function(answer) {
		if (answer === '') { 
			answer = '5433' 
		}
		dynamoConfig.Item.loadClusters.L[0].M.clusterPort = {
			N : '' + common.getIntValue(answer, rl)
		};
		callback(null);
	});
};

q_userName = function(callback) {
	rl.question('Enter the Vertica Database Username (Reqd.) > ', function(answer) {
		common.validateNotNull(answer, 'You Must Provide a Username', rl);
		dynamoConfig.Item.loadClusters.L[0].M.connectUser = {
			S : answer
		};
		callback(null);
	});
};

q_userPwd = function(callback) {
	rl.question('Enter the Vertica Database Password (Reqd.) > ', function(answer) {
		common.validateNotNull(answer, 'You Must Provide a Password', rl);

		kmsCrypto.encrypt(answer, function(err, ciphertext) {
			dynamoConfig.Item.loadClusters.L[0].M.connectPassword = {
				S : kmsCrypto.toLambdaStringFormat(ciphertext)
			};
			callback(null);
		});
	});
};

q_table = function(callback) {
	rl.question('Enter the Table to be Loaded (Reqd.) > ', function(answer) {
		common.validateNotNull(answer, 'You Must Provide a Table Name', rl);
		dynamoConfig.Item.loadClusters.L[0].M.targetTable = {
			S : answer
		};
		callback(null);
	});
};

q_copyOptions = function(callback) {
	rl.question('Load Options - COPY table FROM files [*options*] (Optional)> ', function(answer) {
		if (common.blank(answer) !== null) {
			dynamoConfig.Item.copyOptions = {
				S : answer
			};
		}
		callback(null);
	});
};


q_preLoadStatement = function(callback) {
	rl.question('Enter SQL statement to run before the load (Optional)> ',
			function(answer) {
		                if (common.blank(answer) !== null) {
					dynamoConfig.Item.loadClusters.L[0].M.preLoadStatement = {
						S : answer
					};
                		}
				callback(null);
			});
};

q_postLoadStatement = function(callback) {
	rl.question('Enter SQL statement to run after the load (Optional)> ',
			function(answer) {
		                if (common.blank(answer) !== null) {
					dynamoConfig.Item.loadClusters.L[0].M.postLoadStatement = {
						S : answer
					};
                		}
				callback(null);
			});
};


q_batchSize = function(callback) {
	rl.question('How many files should be buffered before loading? > ',
			function(answer) {
				if (common.blank(answer) !== null) {
					dynamoConfig.Item.batchSize = {
						N : '' + common.getIntValue(answer, rl)
					};
				}
				callback(null);
			});
};

q_batchTimeoutSecs = function(callback) {
	rl
			.question(
					'How old should we allow a Batch to be before loading (seconds)? > ',
					function(answer) {
						if (common.blank(answer) !== null) {
							dynamoConfig.Item.batchTimeoutSecs = {
								N : '' + common.getIntValue(answer, rl)
							};
						}
						callback(null);
					});
};


q_manifestBucket = function(callback) {
	rl
			.question(
					'Enter the S3 Bucket for COPY Manifests (Reqd.) > ',
					function(answer) {
						common
								.validateNotNull(
										answer,
										'You Must Provide a Bucket Name for Manifest File Storage',
										rl);
						dynamoConfig.Item.manifestBucket = {
							S : answer
						};
						callback(null);
					});
};

q_manifestPrefix = function(callback) {
	rl.question('Enter the Prefix for COPY Manifests (Reqd.) > ', function(
			answer) {
		common.validateNotNull(answer,
				'You Must Provide a Prefix for Manifests', rl);
		dynamoConfig.Item.manifestKey = {
			S : answer
		};
		callback(null);
	});
};

q_failedManifestPrefix = function(callback) {
	rl.question('Enter the Prefix to use for Failed Load Manifest Storage (Reqd.) > ',
			function(answer) {
				common.validateNotNull(answer,
						'You Must Provide a Prefix for Manifests', rl);
				dynamoConfig.Item.failedManifestKey = {
					S : answer
				};
				callback(null);
			});
};

q_failureTopic = function(callback) {
	rl.question('Enter the SNS Topic ARN for Failed Loads (Optional) > ',
			function(answer) {
				if (common.blank(answer) !== null) {
					dynamoConfig.Item.failureTopicARN = {
						S : answer
					};
				}
				callback(null);
			});
};

q_successTopic = function(callback) {
	rl.question('Enter the SNS Topic ARN for Successful Loads (Optional) > ', function(
			answer) {
		if (common.blank(answer) !== null) {
			dynamoConfig.Item.successTopicARN = {
				S : answer
			};
		}
		callback(null);
	});
};

last = function(callback) {
	rl.close();

	setup(null, callback);
};

setup = function(overrideConfig, callback) {
	// set which configuration to use
	var useConfig = undefined;
	if (overrideConfig) {
		useConfig = overrideConfig;
	} else {
		useConfig = dynamoConfig;
	}
	var configWriter = common.writeConfig(setRegion, dynamoDB, useConfig,
			callback);
	common.createTables(dynamoDB, configWriter);
};
// export the setup module so that customers can programmatically add new
// configurations
exports.setup = setup;

qs.push(q_region);
qs.push(q_s3Prefix);
qs.push(q_filenameFilter);
qs.push(q_clusterEndpoint);
qs.push(q_clusterPort);
qs.push(q_table);
qs.push(q_copyOptions);
qs.push(q_preLoadStatement);
qs.push(q_postLoadStatement);
qs.push(q_batchSize);
qs.push(q_batchTimeoutSecs);
qs.push(q_userName);
qs.push(q_userPwd);
qs.push(q_manifestBucket);
qs.push(q_manifestPrefix);
qs.push(q_failedManifestPrefix);
qs.push(q_successTopic);
qs.push(q_failureTopic);

// always have to have the 'last' function added to halt the readline channel
// and run the setup
qs.push(last);

// call the first function in the function list, to invoke the callback
// reference chain
async.waterfall(qs);
