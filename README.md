# An Automatic Vertica Database Loader for AWS

Are you using Amazon Web Services for your Vertica cluster(s)? Or are you using Vertica-On-Demand? 
Are you staging your source data files on AWS S3 storage?
If so, this AWS S3 loader for Vertica may be just the thing for you! It will automatically copy your newly created S3 files into target tables in one or more Vertica clusters. 

Here are some of the things it can do:
- pick up source files based on S3 bucket/prefix and filename regex pattern
- configurable batching (multiple files can be batched into one COPY) 
- customize load behavior using any of the many [COPY options](http://my.vertica.com/docs/7.1.x/HTML/index.htm#Authoring/SQLReferenceManual/Statements/COPY/COPY.htm%3FTocPath%3DSQL%2520Reference%2520Manual%7CSQL%2520Statements%7CCOPY%7C_____0) supported by Vertica. Some examples:
	- use a [FlexZone parser](http://my.vertica.com/docs/7.1.x/HTML/index.htm#Authoring/FlexTables/FlexParsersReference.htm%3FTocPath%3DFlex%2520Tables%2520Guide%7CFlex%2520Parsers%2520Reference%7C_____0) to handle a variety of file formats
	- specify ON ANY NODE to balance parallel multi-file loads across the cluster
	- use DIRECT to load bypass WOS when you know the batches are large
- simultaneously load files to multiple clusters. For each cluster you can specify:
	- target table name (can be regular or Flex table)
	- Optional SQL statement to run before the load (e.g. truncate table, swap partitions, etc.) 
	- Optional SQL statement to run after the load (e.g. compute flex table keys and view, clean or transform data, etc.)
- subscribe to recieve batch success/fail notifications (by email or other delivery) 
- monitor loads using AWS Cloudwatch

The Vertica loader runs within the AWS Lambda service, which provides an event-driven, zero-administration compute service. "It allows developers to create applications that are automatically hosted and scaled, while providing a fine-grained pricing structure. With AWS Lambda you get automatic scaling, high availability, and built in Amazon CloudWatch Logging." 

This loader function was inspired by the ["Zero Administration AWS Based Amazon Redshift Loader"](https://blogs.aws.amazon.com/bigdata/post/Tx24VJ6XF1JVJAA/A-Zero-Administration-Amazon-Redshift-Database-Loader), generously published by AWS under the [Amazon Software License](http://aws.amazon.com/asl/). 
Our github repository - ["AWS-Lambda-Vertica-Loader"](https://github.com/rstrahan/aws-lambda-vertica-loader) - was initially forked from the AWSLabs [AWS-Lambda-Redshift-Loader](https://github.com/awslabs/aws-lambda-redshift-loader) repo, and subsequently modified to support Vertica and to add a number of handy features. *Thank you, AWS!*

The architecture leverages several AWS services to great effect. It is fairly straightforward.

- [AWS S3](http://aws.amazon.com/s3) provides source file repository
- [AWS Lambda](http://aws.amazon.com/lambda) is used to run our Vertica Loader function when new files are added to S3
- [AWS DynamoDB](http://aws.amazon.com/dynamodb) is used to store load configurations (passwords are encrypted!), and to track status of batches and individual files
- [AWS SNS](http://aws.amazon.com/sns) (Simple Notification Service) is used to publish notifications for successful and failed loads. Users can subscribe to receive notifications by email.
- [HP Vertica](http://www.vertica.com/), of course, provides the massively scalable, feature loaded, simply fast data analytics platform that we all know and love!

![Loader Architecture](Architecture.png)

## Getting everything set up

There are a few setup steps before you can get started loading files. Don't worry - it's not too hard, and you only need to do it once. Here are the steps. 

### Step 1 - Prepare your Vertica Cluster(s)

Do the following for each cluster you want to load. By the way, you will have lots of flexibility for how you later configure the mapping between source S3 locations/files and the target tables/clusters.  You can load the same sets of files to multiple clusters, or different sets of files to one cluster, or multiple sets of files to multiple clusters, or... well, you get the idea. 

#### Network access
The AWS Lambda service running our loader function must be able to connect to your Vertica cluster over JDBC. In the future, per AWS, AWS Lambda will support presenting the service as though it was inside your own VPC, but for now your Vertica cluster must be reachable from any internet address. Your cluster access is likely set up this way by default, but if not, you must configure your VPC / ACLs / Security Groups accordingly.

#### S3 bucket mounts
Vertica needs access to the files in your S3 bucket(s), and so your bucket(s) must first be mounted to a path on the Vertica node's filesystem. 
If you want to use the 'ON ANY NODE' load option to enable balanced parallel loading, then the bucket will need to be mounted to the same path *on all cluster nodes*.

If you are using [Vertica-On-Demand](http://www.vertica.com/hp-vertica-products/ondemand/) then follow the S3 mapping instructions in the [VOD Loading Guide](https://saas.hp.com/sites/default/files/resources/files/HP_Vertica_OnDemand_LoadingDataGuide.pdf#page=6). Your buckets will be mounted on each node to the path /VOD_<bucket>.  You can now skip to the next step.

If you manage your own vertica cluster, then you will need to use s3fs to mount your S3 buckets.

The s3fs utiliy is pre-installed on cluster nodes built using the latest [HP Vertica AMI](https://aws.amazon.com/marketplace/pp/B00KY7A4OQ/ref=srh_res_product_title?ie=UTF8&sr=0-2&qid=1432228609686).  
If you didn't use the AMI, then you might need to install s3fs - [directions](http://tecadmin.net/mount-s3-bucket-centosrhel-ubuntu-using-s3fs/)).

Now set up your bucket mount on each node as follows:

1. Create the /etc/passwd-s3fs file
```
# sudo echo AWS_ACCESS_KEY_ID:AWS_SECRET_ACCESS_KEY > ~/.passwd-s3fs
# sudo chmod 640 ~/.passwd-s3fs
```
2. Create the mount point directory where we'll mount the bucket - /mnt/s3/<BUCKETNAME>
```
sudo mkdir -p /mnt/s3/<BUCKETNAME>
```
3. Add s3fs entry to /etc/fstab
```
s3fs#<BUCKETNAME>           /mnt/s3/<BUCKETNAME>        fuse    allow_other     0 0
```
4. And finally, mount the bucket
```
sudo mount -a
```

#### Database Tables and Users

You need to make sure each table you want to load exists. 

You can use a regular Vertica column store table, assuming you know the structure of the files that you will be loading. Verify that you have the columns all correctly specified with data types matching the columns in the incoming files.

OR you can use a Flex table if you prefer. With Flex tables, you don't need to define the columns up front - Vertica will automatically determine the structure from your data files (CSV headers, JSON keys, etc.), and will even add new columns on the fly if they appear in the data. If you are not familiar with FlexZone, read these interesting blogs about it [here](http://www.vertica.com/tag/flexzone/). It is very cool! 

You might want to create a new Vertica user for our loader function to use. Give this user a complex password and the minimum set of privileges necessary. Or, you could throw caution to the wind, and just let Lambda connect as dbadmin! It's your decision.

### Step 2 - Install Lambda Function and Execution Roles in AWS

Login to the [AWS console](https://console.aws.amazon.com/console/home), then:

#### Create the Lambda function & role
1.	Go to the AWS Lambda Console in the same region as your S3 bucket and HP Vertica cluster.
2.	Select Create a Lambda function and enter the name MyVerticaDBLoader (for example).
3.	Under 'Code entry type' select 'Upload a zip file' and upload  [AWSLambdaVerticaLoader-1.0.0.zip](https://github.com/rstrahan/aws-lambda-vertica-loader/blob/master/dist/AWSLambdaVerticaLoader-1.0.0.zip) (from the 'dist' folder of the github repo)
4.	Use the default values of 'index.js' for the filename and 'handler' for the handler.
5.	Follow the wizard for creating the AWS Lambda Execution Role. NOTE: You will need IAM privileges to create a new role - you may need your AWS administrator to help with this step if you don't have the required access. Give your new role a sensible name, like 'Lambda_VerticaDB_Loader_Role'. 
5.	Use the max timeout for the function - 60(s).

#### Configure a Lambda event source

1.	On your newly deployed function, select 'Configure Event Source' and select the S3 bucket you want to use for input data. Select 'Put' as the notification type.
2.	Click Submit to save the changes.

#### Edit the new AWS Lambda Execution Role

Add the IAM policy shown below to the role you (or your admin) created for Lambda in the previous step. If you followed my suggestion, this role will be called 'Lambda_VerticaDB_Loader_Role'. If you don't have IAM privileges, you will once again need to ask your AWS admin for help.

This policy will enable Lambda to call SNS, use DynamoDB, write Manifest 
files to S3, and perform encryption with the AWS Key Management Service:

```
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "Stmt1424787824000",
            "Effect": "Allow",
            "Action": [
                "dynamodb:DeleteItem",
                "dynamodb:DescribeTable",
                "dynamodb:GetItem",
                "dynamodb:ListTables",
                "dynamodb:PutItem",
                "dynamodb:Query",
                "dynamodb:Scan",
                "dynamodb:UpdateItem",
                "sns:GetEndpointAttributes",
                "sns:GetSubscriptionAttributes",
                "sns:GetTopicAttributes",
                "sns:ListTopics",
                "sns:Publish",
                "sns:Subscribe",
                "sns:Unsubscribe",
                "s3:Get*",
                "s3:Put*",
                "s3:List*",
                "kms:Decrypt",
                "kms:DescribeKey",
                "kms:GetKeyPolicy"
            ],
            "Resource": [
                "*"
            ]
        }
    ]
}
```

### Step 3 - (Optional) Create SNS Notification Topics
This function can send notifications on completion of batch processing. Using SNS, 
you can then receive notifications through email and HTTP Push to an application, 
or put them into a queue for later processing. You can even invoke additional Lambda
functions to complete your data load workflow using an SNS Event Source for another
AWS Lambda function. To receive SNS notifications for succeeded 
loads, failed loads, or both, create SNS Topics and take note of their Amazon Resource Notations (ARN). 

### Step 4 - Setup client machine, used for configuration and administration 

You will need a machine set up to run the setup and admin scripts. The instructions below assume you will use a RHEL/CentOS machine. You can use an AWS EC2 instance, or an on-premise machine - doesn't matter. 

Make sure git is installed, e.g. for RHEL/CentOS, do:
```
sudo yum install git 
```
Clone the aws-lambda-vertica-loade repo from github
```
git clone https://github.com/rstrahan/aws-lambda-vertica-loader.git
```
Install npm and required node.js packages (yes, the function is written in javascript)
```
sudo yum install npm
cd aws-lambda-redshift-loader
npm install
```
Install AWS Node.js SDK. 
```
npm install aws-sdk
```
Configure the SDK. The full instructions are [here](http://docs.aws.amazon.com/AWSJavaScriptSDK/guide/node-configuring.html), but as a minimum you just need to create a file *~/.aws/credentials* containing your AWS access key and secret key:
```
[default]
aws_access_key_id = AWS_ACCESS_KEY_ID
aws_secret_access_key = AWS_SECRET_ACCESS_KEY
```

In order to ensure communication with the correct AWS Region, you'll need to set 
an environment variable ```AWS_REGION``` to the desired location.

```export AWS_REGION=us-east-1```


### Step 5 - Finally! Entering the Configuration
Now you are ready to create a configuration which tells the function how and if files should be loaded from S3. 

Run the setup.js script by entering ```node setup.js```. The script asks questions 
about how the load should be done - see Configuration Reference appendix as the end of this document. 

**You are now ready to go!** Simply place files that meet the configured format into 
S3 at the location that you configured as the input location, and watch as AWS 
Lambda loads them into your Vertica Cluster. You are charged by the number 
of input files that are processed, plus a small charge for DynamoDB. You now have 
a highly available load framework which doesn't require you manage servers!

# Administration / Configuration changes

## Loading multiple Vertica Clusters concurrently
Run ```node addAdditionalClusterEndpoint.js``` to add new clusters into 
a single configuration. This will require you enter the vital details for the 
cluster including endpoint address and port, DB name and password, table name, load options, pre and post load statements.

## Viewing Previous Batches & Status
If you ever need to see what happened to batch loads into your Cluster, you can 
use the 'queryBatches.js' script to look into the LambdaVerticaBatches DynamoDB 
table. It takes 3 arguments:

* region - the region in which the AWS Lambda function is deployed
* status - the status you are querying for, including 'error', 'complete', 'pending', or 'locked'
* date - optional date argument to use as a start date for querying batches

Running ```node queryBatches.js us-east-1 error``` would return a list of all batches 
with a status of 'error' in the US East region.

You can use describeBatch.js to 
show all detail for a batch. It takes 3 arguments as well:

* region - the region in which the AWS Lambda function is deployed
* batchId - the batch you would like to see the detail for
* s3Prefix - the S3 Prefix the batch was created for

## Clearing Processed Files
We'll only load a file one time by default, but in certain rare cases you might 
want to re-process a file, such as if a batch goes into error state for some reason. 
If so, use the 'processedFiles.js' script to query or delete processed files entries. 
The script takes an 'operation type' and 'filename' as arguments; use -q to query 
if a file has been processed, and -d to delete a given file entry. An example of 
the processed files store can be seen below.
 
## Reprocessing a Batch
If you ever need to reprocess a batch - for example if it failed to load the required 
files for some reason - then you can use the reprocessBatch.js script. This takes 
the same arguments as describeBatch.js (region, batch ID & input location). The 
original input batch is not affected; instead, each of the input files that were 
part of the batch are removed from the LambdaVerticaProcessedFiles table, and 
then the script forces an S3 event to be generated for the file. This will be 
captured and reprocessed by the function as it was originally. Please note you 
can only reprocess batches that are not in 'open' status.

## Unlocking a Batch
It is possible, but rare, that a batch would become locked but not be being processed 
by AWS Lambda. If this were to happen, please use ```unlockBatch.js``` including 
the region and Batch ID to set the batch to 'open' state again.

## Changing your stored Database Password 
Currently you must edit the configuration manually in Dynamo DB to make changes.
If you need to update your Redshift DB Password then you can use the ```encryptValue.js``` script to encrypt
a value using the Lambda Vertica Loader master key and encryption context. 

To run:
```
node encryptValue.js <region> <Value to Encrypt>
```

This script encrypts the value with Amazon KMS, and then verifies the encryption is
correct before returning a JSON object which includes the input value and the
encrypted Ciphertext. You can use the 'encryptedCiphertext' attribute of this object
to update the Dynamo DB Configuration. 

## Ensuring Loads happen every N minutes
If you have a prefix that doesn't receive files very often, and want to ensure 
that files are loaded every N minutes, use the following process to force periodic loads. 

When you create the configuration, add a filenameFilterRegex such as '.*\.csv', which 
only loads CSV files that are put into the specified S3 prefix. Then every N minutes, 
schedule the included dummy file generator through a CRON Job. 

```./path/to/function/dir/generate-trigger-file.py <region> <input bucket> <input prefix> <local working directory>```

* region - the region in which the input bucket for loads resides
* input bucket - the bucket which is configured as an input location
* input prefix - the prefix which is configured as an input location
* local working directory - the location where the stub dummy file will be kept prior to upload into S3

This writes a file called 'lambda-vertica-trigger-file.dummy' to the configured 
input prefix, which causes your deployed function to scan the open pending batch 
and load the contents if the timeout seconds limit has been reached.

## Reviewing Logs
For normal operation, you won't have to do anything from an administration perspective. 
Files placed into the configured S3 locations will be loaded when the number of 
new files equals the configured batch size. You may want to create an operational 
process to deal with failure notifications, but you can also just view the performance 
of your loader by looking at Amazon CloudWatch. Open the CloudWatch console, and 
then click 'Logs' in the lefthand navigation pane. You can then select the log 
group for your function, with a name such as `/aws/lambda/<My Function>`.

Each of the above Log Streams were created by an AWS Lambda function invocation, 
and will be rotated periodically. You can see the last ingestion time, which is 
when AWS Lambda last pushed events into CloudWatch Logging.

You can then review each log stream, and see events where your function simply 
buffered a file, or where it performed a load.

## DynamoDB tables

All data used to manage the lifecycle of data loads is stored in DynamoDB, and 
the setup script automatically provisions the following tables:

* LambdaVerticaBatchLoadConfig - Stores the configuration of how files in an S3 input prefix should be loaded into Vertica.
* LambdaVerticaBatches - Stores the list of all historical and open batches that have been created. There will always be one open batch, and may be multiple closed batches per S3 input prefix from LambdaVerticaBatchLoadConfig.
* LambdaVerticaProcessedFiles - Stores the list of all files entered into a batch, which is also used for deduplication of input files.

*** IMPORTANT ***
The tables used by this function are created with a max read & write per-second rate
of 5. This means that you will be able to accomodate 5 concurrent file uploads
per second being managed by ALL input locations which are event sources to this
Lambda function. If you require more than 5 concurrent invocations/second, then 
you MUST increase the Read IOPS on the LambdaVerticaBatchLoadConfig table, and
the Write IOPS on LambdaVerticaBatches and LambdaVerticaProcessedFiles to the 
maximum number of files to be concurrently processed by all Configurations.

Also please NOTE that AWS Lambda only allows 100 concurrent function invocations
as of 17 Apr 2015, so more than 100 concurrent files will result in Lambda throttling
and there will NOT be any database load done, nor will CloudWatch logs be generated.

The database password will be encrypted by the Amazon Key Management Service. Setup will create a 
new Customer Master Key with an alias named `alias/LambaVerticaLoaderKey`.

# Configuration Reference

The following section provides guidance on the configuration options supported. 
For items such as the batch size, please keep in mind that in Preview the Lambda 
function timeout is 60 seconds. This means that your COPY command must complete 
in less than ~ 50 seconds so that the Lambda function has time to complete writing 
batch metadata. The COPY time will be a function of file size, the number of files 
to be loaded, the size of the cluster, and how many other processes might be consuming 
resource pool queue slots.

Item | Required | Notes
:---- | :--------: | :-----
Enter the Region for the Redshift Load Configuration| Y | Any AWS Region from http://docs.aws.amazon.com/general/latest/gr/rande.html, using the short name (for example us-east-1 for US East 1)
Enter the S3 Bucket & Prefix to watch for files | Y | An S3 Path in format <bucket name>/<prefix>. Prefix is optional
Enter a Filename Filter Regex | N | A Regular Expression used to filter files which appeared in the input prefix before they are processed.
Enter the Cluster Endpoint | Y | The Amazon Redshift Endpoint Address for the Cluster to be loaded.
Enter the Cluster Port | Y | The port on which you have configured your Amazon Redshift Cluster to run.
Enter the Database Name | Y | The database name in which the target table resides.
Enter the Database Username | Y | The username which should be used to connect to perform the COPY. Please note that only table owners can perform COPY, so this should be the schema in which the target table resides.
Enter the Database Password | Y | The password for the database user. Will be encrypted before storage in Dynamo DB.
Enter the Table to be Loaded | Y | The Table Name to be loaded with the input data.
Should the Table be Truncated before Load? (Y/N) | N | Option to truncate the table prior to loading. Use this option if you will subsequently process the input patch and only want to see 'new' data with this ELT process.
Enter the Data Format (CSV or JSON) | Y | Whether the data format is Character Separated Values or JSON data (http://docs.aws.amazon.com/redshift/latest/dg/copy-usage_notes-copy-from-json.html).
If CSV, Enter the CSV Delimiter | Yes if Data Format = CSV | Single character delimiter value, such as ',' (comma) or '|' (pipe).
If JSON, Enter the JSON Paths File Location on S3 (or NULL for Auto) | Yes if Data Format = JSON | Location of the JSON paths file to use to map the file attributes to the database table. If not filled, the COPY command uses option 'json = auto' and the file attributes must have the same name as the column names in the target table.
Enter the S3 Bucket for Redshift COPY Manifests | Y | The S3 Bucket in which to store the manifest files used to perform the COPY. Should not be the input location for the load.
Enter the Prefix for Redshift COPY Manifests| Y | The prefix for COPY manifests.
Enter the Prefix to use for Failed Load Manifest Storage | N | On failure of a COPY, you can elect to have the manifest file copied to an alternative location. Enter that prefix, which will be in the same bucket as the rest of your COPY manifests.
Enter the Access Key used by Redshift to get data from S3 | Y | Amazon Redshift must provide credentials to S3 to be allowed to read data. Enter the Access Key for the Account or IAM user that Amazon Redshift should use.
Enter the Secret Key used by Redshift to get data from S3 | Y | The Secret Key for the Access Key used to get data from S3. Will be encrypted prior to storage in DynamoDB.
Enter the SNS Topic ARN for Failed Loads | N | If you want notifications to be sent to an SNS Topic on successful Load, enter the ARN here. This would be in format 'arn:aws:sns:<region>:<account number>:<topic name>.
Enter the SNS Topic ARN for Successful Loads  | N | SNS Topic ARN for notifications when a batch COPY fails.
How many files should be buffered before loading? | Y | Enter the number of files placed into the input location before a COPY of the current open batch should be performed. Recommended to be an even multiple of the number of CPU's in your cluster. You should set the multiple such that this count causes loads to be every 2-5 minutes.
How old should we allow a Batch to be before loading (seconds)? | N | AWS Lambda will attempt to sweep out 'old' batches using this value as the number of seconds old a batch can be before loading. This 'sweep' is on every S3 event on the input location, regardless of whether it matches the Filename Filter Regex. Not recommended to be below 120.
Additional Copy Options to be added | N | Enter any additional COPY options that you would like to use, as outlined at (http://docs.aws.amazon.com/redshift/latest/dg/r_COPY.html). Please also see http://blogs.aws.amazon.com/bigdata/post/Tx2ANLN1PGELDJU/Best-Practices-for-Micro-Batch-Loading-on-Amazon-Redshift for information on good practices for COPY options in high frequency load environments.

----

Copyright 2014-2015 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Licensed under the Amazon Software License (the "License"). You may not use this file except in compliance with the License. A copy of the License is located at

	http://aws.amazon.com/asl/

or in the "license" file accompanying this file. This file is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions and limitations under the License.
