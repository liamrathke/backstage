/*
 * Copyright 2020 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse, stringify } from 'yaml';
import * as path from 'path';

const protocolPattern = /^(\w{2,}):\/\//i;
const getProtocol = (refPath: string) => {
  const match = protocolPattern.exec(refPath);
  if (match) {
    return match[1].toLowerCase();
  }
  return undefined;
};

export type BundlerRead = (url: string) => Promise<Buffer>;

export type BundlerResolveUrl = (url: string, base: string) => string;

export async function bundleOpenApiSpecification(
  specification: string,
  baseUrl: string,
  read: BundlerRead,
  resolveUrl: BundlerResolveUrl,
): Promise<string> {
  const fileUrlReaderResolver: SwaggerParser.ResolverOptions = {
    canRead: file => {
      const protocol = getProtocol(file.url);
      return protocol === undefined || protocol === 'file';
    },
    read: async file => {
      const relativePath = path.relative('.', file.url);
      const url = resolveUrl(relativePath, baseUrl);
      return await read(url);
    },
  };
  const httpUrlReaderResolver: SwaggerParser.ResolverOptions = {
    canRead: ref => {
      const protocol = getProtocol(ref.url);
      return protocol === 'http' || protocol === 'https';
    },
    read: async ref => {
      const url = resolveUrl(ref.url, baseUrl);
      return await read(url);
    },
  };

  const options: SwaggerParser.Options = {
    resolve: {
      file: fileUrlReaderResolver,
      http: httpUrlReaderResolver,
    },
  };
  const specObject = parse(specification);
  const bundledSpec = await SwaggerParser.bundle(specObject, options);
  return stringify(bundledSpec);
}
