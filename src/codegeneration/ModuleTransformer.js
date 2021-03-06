// Copyright 2012 Traceur Authors.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  BindingElement,
  BindingIdentifier,
  EmptyStatement,
  LiteralPropertyName,
  ObjectPattern,
  ObjectPatternField,
  Script
} from '../syntax/trees/ParseTrees';
import {DirectExportVisitor} from './module/DirectExportVisitor';
import {TempVarTransformer} from './TempVarTransformer';
import {
  EXPORT_DEFAULT,
  EXPORT_SPECIFIER
} from '../syntax/trees/ParseTreeType';
import {VAR} from '../syntax/TokenType';
import {assert} from '../util/assert';
import {
  createArgumentList,
  createBindingIdentifier,
  createExpressionStatement,
  createIdentifierExpression,
  createIdentifierToken,
  createMemberExpression,
  createObjectLiteralExpression,
  createUseStrictDirective,
  createVariableStatement
} from './ParseTreeFactory';
import {
  parseExpression,
  parsePropertyDefinition,
  parseStatement
} from './PlaceholderParser';

export class ModuleTransformer extends TempVarTransformer {
  /**
   * @param {UniqueIdentifierGenerator} identifierGenerator
   */
  constructor(identifierGenerator) {
    super(identifierGenerator);
    this.exportVisitor_ = new DirectExportVisitor();
    this.moduleSpecifierKind_ = null;
    this.url = null;
  }

  getTempVarNameForModuleSpecifier(moduleSpecifier) {
    var moduleName = moduleSpecifier.token.processedValue;
    return '$__' + moduleName.replace(/[^a-zA-Z0-9$]/g, function(c) {
      return '_' + c.charCodeAt(0) + '_';
    }) + '__';
  }

  transformScript(tree) {
    this.url = tree.url;
    return super.transformScript(tree);
  }

  transformModule(tree) {
    this.url = tree.url;

    this.pushTempVarState();

    var statements = [
      createUseStrictDirective(),
      ...this.transformList(tree.scriptItemList),
      this.createExportStatement()
    ];

    this.popTempVarState();

    var funcExpr = parseExpression `function() {
      ${statements}
    }`;

    funcExpr = this.wrapModuleFunction(funcExpr);

    return new Script(tree.location, [createExpressionStatement(funcExpr)]);
  }

  wrapModuleFunction(tree) {
    return parseExpression
      `System.get('@traceur/module').registerModule(${this.url}, ${tree}, this)`;
  }

  /**
   * This creates the code that defines the getter for an export.
   * @param {{string, ParseTree, ModuleSpecifier}} symbol
   * @return {ParseTree}
   */
  getGetterExport({name, tree, moduleSpecifier}) {
    var returnExpression;
    switch (tree.type) {
      case EXPORT_DEFAULT:
        returnExpression = createIdentifierExpression('$__default');
        break;

      case EXPORT_SPECIFIER:
        if (moduleSpecifier) {
          var idName = this.getTempVarNameForModuleSpecifier(moduleSpecifier);
          returnExpression = createMemberExpression(idName, tree.lhs);
        } else {
          returnExpression = createIdentifierExpression(tree.lhs)
        }
        break;

      default:
        returnExpression = createIdentifierExpression(name);
        break;
    }

    return parsePropertyDefinition
        `get ${name}() { return ${returnExpression}; }`;
  }

  createExportStatement() {
    var properties = this.exportVisitor_.namedExports.map((exp) => {
      // export_name: {get: function() { return export_name },
      return this.getGetterExport(exp);
    });
    var object = createObjectLiteralExpression(properties);

    var starExports = this.exportVisitor_.starExports;
    if (starExports.length) {
      var starIdents = starExports.map((moduleSpecifier) => {
        return createIdentifierExpression(
            this.getTempVarNameForModuleSpecifier(moduleSpecifier));
      });
      var args = createArgumentList(object, ...starIdents);
      return parseStatement `return $traceurRuntime.exportStar(${args})`;
    }

    return parseStatement `return ${object}`;
  }

  transformExportDeclaration(tree) {
    this.exportVisitor_.visitAny(tree);
    return this.transformAny(tree.declaration);
  }

  transformExportDefault(tree) {
    return parseStatement `var $__default = ${tree.expression}`;
  }

  transformNamedExport(tree) {
    var moduleSpecifier = tree.moduleSpecifier;

    if (moduleSpecifier) {
      var expression = this.transformAny(moduleSpecifier);
      var idName = this.getTempVarNameForModuleSpecifier(moduleSpecifier);
      return createVariableStatement(VAR, idName, expression);
    }

    return new EmptyStatement(null);
  }

  /**
   * @param {ModuleSpecifier} tree
   * @return {ParseTree}
   */
  transformModuleSpecifier(tree) {
    var token = tree.token;

    var name = tree.token.processedValue;
    var url;
    if (name[0] === '@') {
      url = name;
    } else {
      assert(this.url);
      // import/module {x} from 'name' is relative to the current file.
      url = System.normalResolve(name, this.url);
    }

    return this.getModuleReference(url, this.moduleSpecifierKind_);
  }

  getModuleReference(url, kind = undefined) {
    if (kind === 'module')
      return parseExpression `System.get(${url})`;
    return parseExpression `System.get('@traceur/module').getModuleImpl(${url})`;
  }

  /**
   * @param {ModuleDeclaration} tree
   * @return {VariableDeclaration}
   */
  transformModuleDeclaration(tree) {
    this.moduleSpecifierKind_ = 'module';
    var initialiser = this.transformAny(tree.expression);
    // const a = b.c, d = e.f;
    // TODO(arv): const is not allowed in ES5 strict
    return createVariableStatement(VAR, tree.identifier, initialiser);
  }

  transformImportedBinding(tree) {
    var bindingElement = new BindingElement(tree.location, tree.binding, null);
    var name = new LiteralPropertyName(null, createIdentifierToken('default'));
    return new ObjectPattern(null,
        [new ObjectPatternField(null, name, bindingElement)]);
  }

  transformImportDeclaration(tree) {
    // import {id} from 'module';
    //  =>
    // var {id} = moduleInstance
    //
    // import id from 'module';
    //  =>
    // var {default: id} = moduleInstance
    this.moduleSpecifierKind_ = 'import';
    var binding = this.transformAny(tree.importClause);
    var initialiser = this.transformAny(tree.moduleSpecifier);

    return createVariableStatement(VAR, binding, initialiser);
  }

  transformImportSpecifierSet(tree) {
    var fields = this.transformList(tree.specifiers);
    return new ObjectPattern(null, fields);
  }

  transformImportSpecifier(tree) {
    if (tree.rhs) {
      var binding = new BindingIdentifier(tree.location, tree.rhs);
      var bindingElement = new BindingElement(tree.location, binding, null);
      var name = new LiteralPropertyName(tree.lhs.location, tree.lhs);
      return new ObjectPatternField(tree.location, name, bindingElement);
    }
    return new BindingElement(tree.location,
        createBindingIdentifier(tree.lhs), null);
  }
}
