# dsh-codegraph

CodeGraph 集成插件，为 DSH 提供代码知识图谱能力。

## 功能

基于 [CodeGraph](https://github.com/colbymchenry/codegraph) 项目，提供代码库预索引和关系查询能力：

- **codegraph_build**: 构建或更新代码知识图谱
- **codegraph_query**: 查询代码关系和依赖
- **codegraph_status**: 查看图谱状态和统计信息

## 安装

```bash
# 方法 1: 使用本地链接安装
cd ~/.dsh/profiles/web
npm link D:\dsh_plugin\dsh-codegraph

# 方法 2: 直接复制到 node_modules
cp -r D:\dsh_plugin\dsh-codegraph ~/.dsh/profiles/web/node_modules/@dsh-plugin/codegraph

# 安装依赖并构建
cd ~/.dsh/profiles/web/node_modules/@dsh-plugin/codegraph
npm install
npm run build
```

## 使用

### 构建代码图谱

```
请为当前项目构建代码图谱
```

Agent 会调用 `codegraph_build` 工具分析代码库。

### 查询代码关系

```
查询 UserService 的依赖关系
```

Agent 会调用 `codegraph_query` 工具查找相关代码。

### 查看图谱状态

```
代码图谱的状态如何？
```

Agent 会调用 `codegraph_status` 工具显示统计信息。

## 配置

在 `~/.dsh/config.yml` 中可以配置：

```yaml
plugins:
  codegraph:
    enabled: true
    announceToAgent: true
    codegraphPath: "npx @colbymchenry/codegraph"
    defaultWorkdir: "/path/to/project"
```

## 工作原理

CodeGraph 会分析代码库，生成包含以下信息的知识图谱：

- 函数、类、模块定义
- 导入/导出关系
- 调用关系
- 依赖关系

图谱数据存储在项目的 `.codegraph` 目录中，完全本地运行，不上传任何数据。

## 适用场景

- 大型代码库的快速导航
- 理解复杂依赖关系
- 代码重构时的影响分析
- 新功能开发时的上下文理解

## 限制

- 首次构建需要一定时间（取决于代码库大小）
- 代码变更后需要重新构建以保持图谱最新
- 目前主要支持 JavaScript/TypeScript 项目

## 许可证

MIT
