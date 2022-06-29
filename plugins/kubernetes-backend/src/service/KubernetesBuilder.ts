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
import { Config } from '@backstage/config';
import express from 'express';
import Router from 'express-promise-router';
import fetch from 'node-fetch';
import { Logger } from 'winston';
import { Duration } from 'luxon';
import { getCombinedClusterSupplier } from '../cluster-locator';
import { MultiTenantServiceLocator } from '../service-locator/MultiTenantServiceLocator';
import { KubernetesAuthTranslatorGenerator } from '../kubernetes-auth-translator/KubernetesAuthTranslatorGenerator';
import {
  KubernetesObjectTypes,
  ServiceLocatorMethod,
  CustomResource,
  ClusterDetails,
  KubernetesObjectsProvider,
  ObjectsByEntityRequest,
  KubernetesClustersSupplier,
  KubernetesFetcher,
  KubernetesServiceLocator,
  KubernetesObjectsProviderOptions,
} from '../types/types';
import type { KubernetesRequestAuth } from '@backstage/plugin-kubernetes-common';
import { KubernetesClientProvider } from './KubernetesClientProvider';
import {
  DEFAULT_OBJECTS,
  KubernetesFanOutHandler,
} from './KubernetesFanOutHandler';
import { KubernetesClientBasedFetcher } from './KubernetesFetcher';

import { KubeConfig } from '@kubernetes/client-node';

/**
 *
 * @alpha
 */
export interface KubernetesEnvironment {
  logger: Logger;
  config: Config;
}

enum RequestMethod {
  Get = 'GET',
  Post = 'POST',
}

export interface KubernetesProxyRequest {
  method: RequestMethod;
  cluster: string;
  authMetadata: KubernetesRequestAuth;
  encodedQuery: string;
}

/**
 * The return type of the `KubernetesBuilder.build` method
 *
 * @alpha
 */
export type KubernetesBuilderReturn = Promise<{
  router: express.Router;
  clusterSupplier: KubernetesClustersSupplier;
  customResources: CustomResource[];
  fetcher: KubernetesFetcher;
  objectsProvider: KubernetesObjectsProvider;
  serviceLocator: KubernetesServiceLocator;
}>;

/**
 *
 * @alpha
 */
export class KubernetesBuilder {
  private clusterSupplier?: KubernetesClustersSupplier;
  private defaultClusterRefreshInterval: Duration = Duration.fromObject({
    minutes: 60,
  });
  private objectsProvider?: KubernetesObjectsProvider;
  private fetcher?: KubernetesFetcher;
  private serviceLocator?: KubernetesServiceLocator;

  static createBuilder(env: KubernetesEnvironment) {
    return new KubernetesBuilder(env);
  }

  constructor(protected readonly env: KubernetesEnvironment) {}

  public async build(): KubernetesBuilderReturn {
    const logger = this.env.logger;
    const config = this.env.config;

    logger.info('Initializing Kubernetes backend');

    if (!config.has('kubernetes')) {
      if (process.env.NODE_ENV !== 'development') {
        throw new Error('Kubernetes configuration is missing');
      }
      logger.warn(
        'Failed to initialize kubernetes backend: kubernetes config is missing',
      );
      return {
        router: Router(),
      } as unknown as KubernetesBuilderReturn;
    }
    const customResources = this.buildCustomResources();

    const fetcher = this.fetcher ?? this.buildFetcher();

    const clusterSupplier =
      this.clusterSupplier ??
      this.buildClusterSupplier(this.defaultClusterRefreshInterval);

    const serviceLocator =
      this.serviceLocator ??
      this.buildServiceLocator(this.getServiceLocatorMethod(), clusterSupplier);

    const objectsProvider =
      this.objectsProvider ??
      this.buildObjectsProvider({
        logger,
        fetcher,
        serviceLocator,
        customResources,
        objectTypesToFetch: this.getObjectTypesToFetch(),
      });

    const router = this.buildRouter(objectsProvider, clusterSupplier);

    return {
      clusterSupplier,
      customResources,
      fetcher,
      objectsProvider,
      router,
      serviceLocator,
    };
  }

  public setClusterSupplier(clusterSupplier?: KubernetesClustersSupplier) {
    this.clusterSupplier = clusterSupplier;
    return this;
  }

  public setDefaultClusterRefreshInterval(refreshInterval: Duration) {
    this.defaultClusterRefreshInterval = refreshInterval;
    return this;
  }

  public setObjectsProvider(objectsProvider?: KubernetesObjectsProvider) {
    this.objectsProvider = objectsProvider;
    return this;
  }

  public setFetcher(fetcher?: KubernetesFetcher) {
    this.fetcher = fetcher;
    return this;
  }

  public setServiceLocator(serviceLocator?: KubernetesServiceLocator) {
    this.serviceLocator = serviceLocator;
    return this;
  }

  protected buildCustomResources() {
    const customResources: CustomResource[] = (
      this.env.config.getOptionalConfigArray('kubernetes.customResources') ?? []
    ).map(
      c =>
        ({
          group: c.getString('group'),
          apiVersion: c.getString('apiVersion'),
          plural: c.getString('plural'),
          objectType: 'customresources',
        } as CustomResource),
    );

    this.env.logger.info(
      `action=LoadingCustomResources numOfCustomResources=${customResources.length}`,
    );
    return customResources;
  }

  protected buildClusterSupplier(
    refreshInterval: Duration,
  ): KubernetesClustersSupplier {
    const config = this.env.config;
    return getCombinedClusterSupplier(config, refreshInterval);
  }

  protected buildObjectsProvider(
    options: KubernetesObjectsProviderOptions,
  ): KubernetesObjectsProvider {
    return new KubernetesFanOutHandler(options);
  }

  protected buildFetcher(): KubernetesFetcher {
    return new KubernetesClientBasedFetcher({
      kubernetesClientProvider: new KubernetesClientProvider(),
      logger: this.env.logger,
    });
  }

  protected buildServiceLocator(
    method: ServiceLocatorMethod,
    clusterSupplier: KubernetesClustersSupplier,
  ): KubernetesServiceLocator {
    switch (method) {
      case 'multiTenant':
        return this.buildMultiTenantServiceLocator(clusterSupplier);
      case 'http':
        return this.buildHttpServiceLocator(clusterSupplier);
      default:
        throw new Error(
          `Unsupported kubernetes.clusterLocatorMethod "${method}"`,
        );
    }
  }

  protected buildMultiTenantServiceLocator(
    clusterSupplier: KubernetesClustersSupplier,
  ): KubernetesServiceLocator {
    return new MultiTenantServiceLocator(clusterSupplier);
  }

  protected buildHttpServiceLocator(
    _clusterSupplier: KubernetesClustersSupplier,
  ): KubernetesServiceLocator {
    throw new Error('not implemented');
  }

  protected buildRouter(
    objectsProvider: KubernetesObjectsProvider,
    clusterSupplier: KubernetesClustersSupplier,
  ): express.Router {
    const logger = this.env.logger;
    const router = Router();
    router.use(express.json());

    router.post('/services/:serviceId', async (req, res) => {
      const serviceId = req.params.serviceId;
      const requestBody: ObjectsByEntityRequest = req.body;
      try {
        const response = await objectsProvider.getKubernetesObjectsByEntity({
          entity: requestBody.entity,
          auth: requestBody.auth || {},
        });
        res.json(response);
      } catch (e) {
        logger.error(
          `action=retrieveObjectsByServiceId service=${serviceId}, error=${e}`,
        );
        res.status(500).json({ error: e.message });
      }
    });

    router.get('/clusters', async (_, res) => {
      const clusterDetails = await this.fetchClusterDetails(clusterSupplier);
      res.json({
        items: clusterDetails.map(cd => ({
          name: cd.name,
          dashboardUrl: cd.dashboardUrl,
          authProvider: cd.authProvider,
          oidcTokenProvider: cd.oidcTokenProvider,
        })),
      });
    });

    router.get('/proxy/:encodedQuery', async (req, res) => {
      const cluster = req.header('X-Kubernetes-Cluster') ?? '';
      const authMetadata = JSON.parse(
        req.header('X-Auth-Metadata') ?? '{}',
      ) as KubernetesRequestAuth;
      const encodedQuery = req.params.encodedQuery;

      const proxyRequest: KubernetesProxyRequest = {
        method: RequestMethod.Get,
        cluster,
        authMetadata,
        encodedQuery,
      };

      const proxyResponse = await this.makeProxyRequest(proxyRequest);
      res.json(proxyResponse);
    });

    router.post('/proxy/:encodedQuery', async (req, res) => {
      const cluster = req.header('X-Kubernetes-Cluster') ?? '';
      const authMetadata = JSON.parse(
        req.header('X-Auth-Metadata') ?? '{}',
      ) as KubernetesRequestAuth;
      const encodedQuery = req.params.encodedQuery;

      const proxyRequest: KubernetesProxyRequest = {
        method: RequestMethod.Post,
        cluster,
        authMetadata,
        encodedQuery,
      };

      const proxyResponse = await this.makeProxyRequest(proxyRequest);
      res.json(proxyResponse);
    });

    return router;
  }

  protected async fetchClusterDetails(
    clusterSupplier: KubernetesClustersSupplier,
  ) {
    const clusterDetails = await clusterSupplier.getClusters();

    this.env.logger.info(
      `action=loadClusterDetails numOfClustersLoaded=${clusterDetails.length}`,
    );

    return clusterDetails;
  }

  protected getServiceLocatorMethod() {
    return this.env.config.getString(
      'kubernetes.serviceLocatorMethod.type',
    ) as ServiceLocatorMethod;
  }

  protected getObjectTypesToFetch() {
    const objectTypesToFetchStrings = this.env.config.getOptionalStringArray(
      'kubernetes.objectTypes',
    ) as KubernetesObjectTypes[];

    const apiVersionOverrides = this.env.config.getOptionalConfig(
      'kubernetes.apiVersionOverrides',
    );

    let objectTypesToFetch;

    if (objectTypesToFetchStrings) {
      objectTypesToFetch = DEFAULT_OBJECTS.filter(obj =>
        objectTypesToFetchStrings.includes(obj.objectType),
      );
    }

    if (apiVersionOverrides) {
      objectTypesToFetch = objectTypesToFetch ?? DEFAULT_OBJECTS;

      for (const obj of objectTypesToFetch) {
        if (apiVersionOverrides.has(obj.objectType)) {
          obj.apiVersion = apiVersionOverrides.getString(obj.objectType);
        }
      }
    }

    return objectTypesToFetch;
  }

  protected async makeProxyRequest(req: KubernetesProxyRequest): Promise<any> {
    console.log('making proxy request');

    const clusterSupplier =
      this.clusterSupplier ??
      this.buildClusterSupplier(this.defaultClusterRefreshInterval);
    if (!clusterSupplier) {
      // error
      this.env.logger.error('could not find cluster supplier!');
      return null;
    }

    const clusterDetails = await this.fetchClusterDetails(clusterSupplier);
    console.log('Cluster Details');
    console.log(clusterDetails);
    console.log(req.cluster);
    const details = clusterDetails.find(c => c.name === req.cluster);

    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    if (!details) {
      // error
      this.env.logger.error('could not find cluster details!');
      return null;
    }

    console.log('here1');

    const detailsWithAuth = await this.configureAuth(details, req.authMetadata);
    const client = this.getKubeConfig(detailsWithAuth);
    console.log(client.users[0].token);

    const decodedQuery = decodeURIComponent(req.encodedQuery);

    const clientURI = `${client.getCurrentCluster()?.server}/${decodedQuery}`;

    console.log(clientURI);

    const oidcKeys = Object.keys(req.authMetadata.oidc || {});
    console.log('OIDCKEYS!', oidcKeys);
    if (oidcKeys.length < 1) {
      // error
      return null;
    }
    const bearerToken = req.authMetadata.oidc?.[oidcKeys[0]];
    console.log('BEARER TOKEN!', bearerToken);

    const res = await fetch(clientURI, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
    });

    console.log(res.json);

    return res.json();
  }

  protected getKubeConfig(clusterDetails: ClusterDetails) {
    const cluster = {
      name: clusterDetails.name,
      server: clusterDetails.url,
      skipTLSVerify: clusterDetails.skipTLSVerify,
      caData: clusterDetails.caData,
    };

    // TODO configure
    const user = {
      name: 'backstage',
      token: clusterDetails.serviceAccountToken,
    };

    const context = {
      name: `${clusterDetails.name}`,
      user: user.name,
      cluster: cluster.name,
    };

    const kc = new KubeConfig();
    if (clusterDetails.serviceAccountToken) {
      kc.loadFromOptions({
        clusters: [cluster],
        users: [user],
        contexts: [context],
        currentContext: context.name,
      });
    } else {
      kc.loadFromDefault();
    }

    return kc;
  }

  protected async configureAuth(
    details: ClusterDetails,
    authMetadata: KubernetesRequestAuth,
  ): Promise<ClusterDetails> {
    const options = {
      logger: this.env.logger,
    };
    const authTranslator =
      KubernetesAuthTranslatorGenerator.getKubernetesAuthTranslatorInstance(
        details.authProvider,
        options,
      );
    return authTranslator.decorateClusterDetailsWithAuth(details, {
      auth: authMetadata,
    } as KubernetesRequestAuth);
  }
}
