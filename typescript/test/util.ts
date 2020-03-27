// Copyright 2020 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as fs from 'fs-extra';
import * as path from 'path';
import {before, it} from 'mocha';
import * as rimraf from 'rimraf';
import {execSync} from 'child_process';
import * as assert from 'assert';

const NO_OUTPUT_FILE = 0;
const IDENTICAL_FILE = 1;
const FILE_WITH_DIFF_CONTENT = 2;

const BASELINE_EXTENSION = '.baseline';

export interface BaselineOptions {
  outputDir: string;
  protoPath: string;
  useCommonProto: boolean;
  baselineName: string;
  mainServiceName?: string;
  grpcServiceConfig?: string;
  packageName?: string;
  template?: string;
  bundleConfig?: string;
}

const cwd = process.cwd();
const googleGaxProtosDir = path.join(
  cwd,
  'node_modules',
  'google-gax',
  'protos'
);
const protosDirRoot = path.join(cwd, 'test-fixtures', 'protos');
const commonProtoFilePath = path.join(
  protosDirRoot,
  'google',
  'cloud',
  'common_resources.proto'
);
const baselineRootDir = path.join(cwd, 'baselines');
const srcDir = path.join(cwd, 'build', 'src');
const cliPath = path.join(srcDir, 'cli.js');
const pluginPath = path.join(srcDir, 'protoc-gen-typescript_gapic');
const startScriptPath = path.join(cwd, 'build', 'src', 'start-script.js');

export function initBaselineTest() {
  before(() => {
    if (fs.existsSync(pluginPath)) {
      rimraf.sync(pluginPath);
    }
    fs.copyFileSync(cliPath, pluginPath);
    process.env['PATH'] = srcDir + path.delimiter + process.env['PATH'];

    try {
      execSync(`chmod +x ${pluginPath} ${cliPath}`);
    } catch (err) {
      console.warn(`Failed to chmod +x ${pluginPath}: ${err}. Ignoring...`);
    }
  });
}

export function runBaselineTest(options: BaselineOptions) {
  const outputDir = path.join(cwd, options.outputDir);
  const protoPath = path.join(
    protosDirRoot,
    options.protoPath.split('/').join(path.sep)
  );
  const baselineDir = path.join(baselineRootDir, options.baselineName);
  const grpcServiceConfig = options.grpcServiceConfig
    ? path.join(
        protosDirRoot,
        options.grpcServiceConfig.split('/').join(path.sep)
      )
    : undefined;
  const bundleConfig = options.bundleConfig
    ? path.join(protosDirRoot, options.bundleConfig.split('/').join(path.sep))
    : undefined;
  it(options.baselineName, function () {
    this.timeout(60000);
    if (fs.existsSync(outputDir)) {
      rimraf.sync(outputDir);
    }
    fs.mkdirSync(outputDir);

    let commandLine =
      `node ${startScriptPath} --output_dir=${outputDir} ` +
      `-I${protosDirRoot} -I${googleGaxProtosDir} ${protoPath}`;
    if (options.useCommonProto) {
      commandLine += ` ${commonProtoFilePath}`;
    }
    if (options.mainServiceName) {
      commandLine += ` --main-service=${options.mainServiceName}`;
    }
    if (grpcServiceConfig) {
      commandLine += ` --grpc-service-config=${grpcServiceConfig}`;
    }
    if (options.packageName) {
      commandLine += ` --package-name=${options.packageName}`;
    }
    if (options.template) {
      commandLine += ` --template="${options.template}"`;
    }
    if (options.bundleConfig) {
      commandLine += ` --bundle-config="${bundleConfig}"`;
    }

    execSync(commandLine);
    assert(equalToBaseline(outputDir, baselineDir));
  });
}

function equalToBaseline(outpurDir: string, baselineDir: string): boolean {
  let result = true;
  // put all baseline files into fileStack
  let fileStack: string[] = [];
  const dirStack: string[] = [];
  putAllBaselineFiles(baselineDir, fileStack, dirStack);
  // store every item (file or directory with full path in output dir and baseline dir) in stack, pop once a time
  const protoItemStack: Item[] = [];
  putItemToStack(protoItemStack, outpurDir, baselineDir);
  while (protoItemStack.length !== 0) {
    const item = protoItemStack[protoItemStack.length - 1];
    protoItemStack.pop();
    // if item is a file, compare it with baseline
    if (fs.lstatSync(item.outputPath).isFile()) {
      const compareResult = checkIdenticalFile(
        item.outputPath,
        item.baselinePath + BASELINE_EXTENSION
      );
      if (compareResult === NO_OUTPUT_FILE) {
        result = false;
      }
      // if two files are identical or it's generated properly, filter it from the stack.
      if (
        compareResult === IDENTICAL_FILE ||
        compareResult === NO_OUTPUT_FILE
      ) {
        fileStack = fileStack.filter(
          file => file !== item.baselinePath + BASELINE_EXTENSION
        );
      }
    } else if (fs.lstatSync(item.outputPath).isDirectory()) {
      // if item is a directory, loop the folder and put every item in stack again
      putItemToStack(protoItemStack, item.outputPath, item.baselinePath);
    }
  }
  if (fileStack.length !== 0) {
    fileStack.forEach(file => {
      console.warn(file + ' is not identical with the generated file. ');
    });
    result = false;
  }
  return result;
}

function checkIdenticalFile(
  outputFullPath: string,
  baselineFullPath: string
): number {
  if (outputFullPath.endsWith('.proto')) {
    return IDENTICAL_FILE;
  }
  if (!fs.existsSync(baselineFullPath)) {
    console.warn(baselineFullPath + ' is not generated. ');
    return NO_OUTPUT_FILE;
  }
  const readOutput = fs.readFileSync(outputFullPath).toString();
  const baselineOutput = fs.readFileSync(baselineFullPath).toString();
  if (readOutput === baselineOutput) return IDENTICAL_FILE;

  const readOutputLines = readOutput.split('\n');
  const baselineOutputLines = baselineOutput.split('\n');

  if (readOutputLines.length !== baselineOutputLines.length) {
    console.warn(
      `Line count for ${outputFullPath} was ${readOutputLines.length}, ` +
        `but expected ${baselineOutputLines.length}.`
    );
  } else {
    for (let i = 0; i < readOutputLines.length; ++i) {
      if (readOutputLines[i] !== baselineOutputLines[i]) {
        console.warn(
          `Line ${i + 1} of ${outputFullPath} was \n\t"${
            readOutputLines[i]
          }"\nbut expected\n\t"${baselineOutputLines[i]}"`
        );
      }
    }
  }

  return FILE_WITH_DIFF_CONTENT;
}

function putItemToStack(
  protoItemStack: Item[],
  outputDir: string,
  baselinDir: string
) {
  const outputFiles = fs.readdirSync(outputDir);

  outputFiles.forEach(file => {
    const fileFullPath = path.join(outputDir, file);
    const baselinePath = path.join(baselinDir, file);
    protoItemStack.push(new Item(file, fileFullPath, baselinePath));
  });
}

function putFiletoStack(dir: string, fileStack: string[], dirStack: string[]) {
  const items = fs.readdirSync(dir);
  items.forEach(item => {
    const baselinePath = path.join(dir, item);
    if (
      fs.statSync(baselinePath).isFile() &&
      baselinePath.endsWith(BASELINE_EXTENSION)
    ) {
      fileStack.push(baselinePath);
    } else if (fs.statSync(baselinePath).isDirectory()) {
      dirStack.push(baselinePath);
    }
  });
}

function putAllBaselineFiles(
  dir: string,
  fileStack: string[],
  dirStack: string[]
) {
  putFiletoStack(dir, fileStack, dirStack);
  while (dirStack.length !== 0) {
    const dir = dirStack.pop();
    putFiletoStack(dir!, fileStack, dirStack);
  }
}

class Item {
  fileName: string; // file name: package.json
  outputPath: string; // full path in output folder: __dirname/.../.baseline-test-out/package.json
  baselinePath: string; // full baseline path: __dirname/.../test/testdata/showcase/package.json.baseline
  constructor(file: string, output: string, baseline: string) {
    this.fileName = file;
    this.outputPath = output;
    this.baselinePath = baseline;
  }
}
