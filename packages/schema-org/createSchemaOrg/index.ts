import type { ComponentInternalInstance } from 'vue-demi'
import { joinURL, withProtocol, withTrailingSlash } from 'ufo'
import { defu } from 'defu'
import { hash } from 'ohash'
import { computed, getCurrentInstance, onMounted, reactive, readonly, ref, unref, watchEffect } from 'vue-demi'
import type { HeadClient } from '@vueuse/head'
import { injectHead } from '@vueuse/head'
import type {
  ConsolaFn,
  CreateSchemaOrgInput,
  Id,
  IdGraph,
  SchemaNode,
  SchemaOrgClient,
  SchemaOrgContext, UseSchemaOrgInput,
} from '../types'
import { prefixId, resolveRawId } from '../utils'

export const PROVIDE_KEY = 'schemaorg'

export const createSchemaOrg = (options: CreateSchemaOrgInput) => {
  options = defu(options, {
    debug: false,
    defaultLanguage: 'en',
  })
  const idGraph: IdGraph = {}
  const schemaRef = ref<string>('')

  // eslint-disable-next-line no-console
  let debug: ConsolaFn | ((...arg: any) => void) = (...arg: any) => { options.debug && console.debug(...arg) }
  // eslint-disable-next-line no-console
  let warn: ConsolaFn | ((...arg: any) => void) = (...arg: any) => { console.warn(...arg) }
  // opt-in to consola if available
  try {
    import('consola').then((consola) => {
      const logger = consola.default.withScope('@vueuse/schema-org')
      if (options.debug) {
        logger.level = 4
        debug = logger.debug
      }
      warn = logger.warn
    }).catch()
  }
  // if consola is missing it's not a problem
  catch (e) {}
  //
  if (!options.useRoute)
    warn('Missing useRoute implementation. Provide a `useRoute` handler, usually from `vue-router`.')

  if (!options.canonicalHost) {
    warn('Missing required `canonicalHost` from `createSchemaOrg`.')
  }
  else {
    // all urls should be fully qualified, such as https://example.com/
    options.canonicalHost = withTrailingSlash(withProtocol(options.canonicalHost, 'https://'))
  }

  let _domSetup = false

  const client: SchemaOrgClient = {
    install(app) {
      app.config.globalProperties.$schemaOrg = client
      app.provide(PROVIDE_KEY, client)
    },

    debug,
    schemaRef,
    options,

    setupRouteContext(vm: ComponentInternalInstance) {
      const host = options.canonicalHost || ''
      const route = options.useRoute()

      const ctx = reactive<SchemaOrgContext>({
        meta: {},
        canonicalHost: host,
        canonicalUrl: '',
        uid: vm.uid,
        // meta
        findNode: client.findNode,
        addNode: client.addNode,
        options: client.options,
      })

      watchEffect(() => {
        ctx.canonicalUrl = joinURL(host, route.path)

        if (options.provider === 'vitepress') {
          const vitepressData = (route as typeof route & { data: any }).data
          ctx.meta = {
            ...vitepressData,
            ...vitepressData.frontmatter,
          }
        }
        else {
          ctx.meta = route.meta || {}
        }
      })

      // if we have access to the instance
      if (getCurrentInstance()) {
        onMounted(() => {
          if (!ctx.canonicalHost)
            ctx.canonicalHost = `${window.location.protocol}//${window.location.host}`
          // if route meta is missing some data, we can try and fill it using the document, if available
          if (!ctx.meta.title)
            ctx.meta.title = document.title || undefined
          if (!ctx.meta.description)
            ctx.meta.description = document.querySelector('meta[name="description"]')?.getAttribute('content') || undefined
          if (!ctx.meta.image)
            ctx.meta.image = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || undefined
          // Note: this will trigger the schema to be re-generated if a value changes
        })
      }

      return ctx
    },

    addNodesAndResolveRelations(ctx, nodes) {
      nodes = (Array.isArray(nodes) ? nodes : [nodes]) as UseSchemaOrgInput[]

      ctx = readonly(ctx)
      const addedNodes = new Set<Id>()
      const resolvedNodes = nodes
        .map((n: any) => {
          if (typeof n.resolve !== 'undefined') {
            return {
              ...n,
              node: n.resolve(ctx),
            }
          }
          if (!n['@id'])
            n['@id'] = prefixId(ctx.canonicalHost, `#${hash(n)}`)
          return {
            node: reactive(n),
          }
        })
      // add the nodes
      resolvedNodes.forEach(({ node }: any) => {
        addedNodes.add(client.addNode(node, ctx))
      })
      // finally, we need to allow each node to merge in relations from the idGraph
      resolvedNodes.forEach((n: any) => {
        if (typeof n.resolveAsRootNode !== 'undefined')
          n.resolveAsRootNode(ctx)
      })
      return addedNodes
    },

    generateSchema() {
      schemaRef.value = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': client.graphNodes,
      }, undefined, 2)
    },

    findNode<T extends SchemaNode>(id: Id) {
      const key = resolveRawId(id)
      return client.graphNodes.find(n => resolveRawId(n['@id']) === key) as unknown as T | null
    },

    addNode(node, ctx) {
      const key = resolveRawId(node['@id'])
      idGraph[ctx.uid] = defu({
        [key]: node,
      }, idGraph[ctx.uid] || {})
      return key
    },

    removeContext(ctx) {
      delete idGraph[ctx.uid]
    },

    get graphNodes() {
      // create the nodes
      const nodes: Record<Id, SchemaNode> = {}
      // iterating up through the object keys, we add them by id in ascending order
      Object.keys(idGraph)
        .sort((a, b) => parseInt(a) - parseInt(b))
        .forEach((key) => {
          Object
            .values(idGraph[parseInt(key)])
            .map(n => unref(n))
            .forEach((n) => {
              nodes[resolveRawId(n['@id'])] = n
            })
        })
      // flatten them
      return Object.values(nodes)
    },

    setupDOM() {
      let head: HeadClient | null = null
      try {
        // head may not be available in SSR (vitepress)
        head = options.head || injectHead()
      }
      catch (e) {
        debug('DOM setup failed, couldn\'t fetch injectHead')
      }
      if (!head)
        return

      // we only need to init the DOM once since we have a reactive head object and a watcher to update the DOM
      if (_domSetup)
        return

      head.addHeadObjs(computed(() => {
        return {
          // Can be static or computed
          script: [
            {
              type: 'application/ld+json',
              key: 'root-schema-org-graph',
              children: schemaRef.value,
            },
          ],
        }
      }))
      watchEffect(() => {
        if (head && typeof window !== 'undefined')
          head.updateDOM()
      })
      _domSetup = true
    },
  }
  return client
}
