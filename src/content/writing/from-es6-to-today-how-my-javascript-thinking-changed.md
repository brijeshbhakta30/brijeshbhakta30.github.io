---
permalink: /javascript/from-es6-to-today-how-my-javascript-thinking-changed
title: "From ES6 to Today: How My JavaScript Thinking Changed"
category: JavaScript
tags:
  - JavaScript
  - TypeScript
  - Product engineering
description: "A retrospective on ES6, TypeScript, async code, frameworks, and how my opinions about JavaScript have changed after years of building production software."
publishedAt: 2026-09-06
draft: true
---

In 2017, I wrote a post called [Getting started with ES6](/javascript/getting-started-with-es6).

At the time, features like classes, `let` and `const`, arrow functions, destructuring, template literals, iterators, and promises genuinely felt like modern JavaScript arriving. I was learning those features, using them in real projects, and writing down what I understood.

I still like that I wrote it.

Some parts are basic now. Some advice is more absolute than I would give today. A few examples are written in a style I would probably not use anymore. But that is also what makes it useful to look back at. It captures a moment when ES6 was still something you had to consciously learn.

Nine years later, I still use many of those features every day. What changed much more than the syntax is how I think about using them.

## ES6 stopped feeling like ES6

I do not think about `const`, destructuring, template literals, arrow functions, promises, or modules as ES6 features anymore. They are just JavaScript.

That is probably the clearest sign that a language feature has settled in. It disappears into the way people write code. Nobody reaches for `const` because they are trying to write "ES6 style" JavaScript. They use it because it is the natural default when a binding does not need to be reassigned.

The same is true for destructuring:

```js
const { id, name, email } = user;
```

or template literals:

```js
const profileUrl = `/users/${user.id}`;
```

or async code:

```js
const account = await getAccount(accountId);
```

These features are no longer the interesting part of most applications. They are the vocabulary. The real work is in deciding where data should live, how state should change, what the API contract should be, what can fail, and how easy the code will be to change later.

In 2017, learning the syntax felt like a major step forward. Today, the syntax is the easy part.

## Some of my old advice became less absolute

One part of the old post that stands out to me is the section on iterating over arrays.

I wrote:

> Do not use any loop to iterate over the array like `for-of, for` etc.

That sentence feels very 2016 to me.

I understand why I wrote it. I was trying to move away from older JavaScript habits and toward array methods like `map`, `filter`, `find`, `some`, and `reduce`. That was a good direction. Those methods are still excellent when they match the shape of the problem.

Use `map` when you are transforming every item.

```js
const names = users.map((user) => user.name);
```

Use `filter` when you are keeping some items and removing others.

```js
const activeUsers = users.filter((user) => user.isActive);
```

Use `find` when you need the first matching item.

```js
const selectedUser = users.find((user) => user.id === selectedUserId);
```

The part I would change today is the rule itself. I would not tell someone to avoid loops entirely.

Sometimes a `for...of` loop is clearer:

```js
const validItems = [];
const errors = [];

for (const item of items) {
  const result = validateItem(item);

  if (result.ok) {
    validItems.push(result.value);
  } else {
    errors.push(result.error);
  }
}
```

Could this be written with `reduce`? Yes. Would that automatically make it better? No.

That is one of the opinions I have softened over time. JavaScript gives us expressive tools, but expressiveness is not the same thing as clarity. A clever `reduce` can feel satisfying when you write it and annoying when someone has to debug it three months later.

I still reach for array methods constantly. I just do not treat them like a prize for avoiding a loop.

Boring code is often pretty good code.

## Classes mattered more to me then than they do now

My original ES6 article spent meaningful space introducing classes. That made sense at the time. ES6 classes were a big visible feature, and they gave JavaScript developers a more familiar syntax for constructor functions and prototypes.

I still think classes are useful in the right place. They can be a good fit for domain objects, SDK clients, state machines, infrastructure wrappers, and places where you want to bind data and behavior together.

But classes are not as central to my everyday JavaScript as I probably expected in 2016.

After years of working with React and React Native, functions, composition, and hooks have become much more common in the code I write. A lot of product code is about small functions, clear data flow, predictable state updates, and composing behavior without building large inheritance structures.

This is not a "classes are bad" argument. It is more that the importance I assigned to them in 2016 did not match where my daily JavaScript eventually went.

In practice, I now care less about whether code is organized around a class or a function, and more about whether its responsibilities are obvious.

Can I see what it owns?

Can I see what it depends on?

Can I test it without dragging half the application into the test?

Can I change one part without surprising another part?

Those questions matter more than the syntax used to group the code.

## Promises won, but async code did not become easy

Promises were one of the most important parts of ES6. They gave JavaScript a standard way to represent asynchronous work, and `async` / `await` later made that work much easier to read.

I am grateful for that. I do not miss callback-heavy code.

But production experience teaches you that syntax was never the hardest part of asynchronous JavaScript.

This is readable:

```js
const profile = await getProfile(userId);
const permissions = await getPermissions(userId);
```

But the real questions are underneath it.

What happens if the profile request fails?

Should the permissions request still run?

Can the user leave the screen while the request is pending?

What if a newer request finishes before an older request?

What does the interface show while data is loading?

Should failed work be retried?

Is the operation safe to retry?

What happens when the network is unreliable?

What happens when the server succeeds but the client never receives the response?

That is where asynchronous code becomes difficult. Not in the `await`, but in everything around it.

In mobile apps, this gets even more interesting. The app can go to the background. Connectivity can change. Native permissions can interrupt the flow. A user can tap faster than the screen was designed for. The happy path is only one version of reality.

Promises and `async` / `await` made asynchronous code nicer to express. They did not remove the need to design for failure, cancellation, ordering, stale data, and recovery.

## TypeScript changed how I write JavaScript

The biggest difference between my 2016 JavaScript and my JavaScript today is TypeScript.

I do not mean that in the simple "TypeScript is better than JavaScript" way. JavaScript is still the runtime. Understanding JavaScript still matters. TypeScript does not save you from unclear architecture, confusing state, bad names, or the wrong abstraction.

But TypeScript changed the kinds of problems I try to solve with code.

Earlier in my career, I might have relied more heavily on naming conventions, comments, or defensive checks to explain what shape of data a function expected. Today, I prefer making that contract visible in the type system where it makes sense.

```ts
type PaymentStatus = 'pending' | 'paid' | 'failed' | 'refunded';

type Payment = {
  id: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
};
```

That does not make payment logic simple. But it gives the code a clearer boundary. It tells the next developer, including future me, what states are expected.

The most useful TypeScript code I write is not the most complicated. It is usually the code that makes invalid states harder to represent and important boundaries easier to understand.

For example, in product code, I care about types around:

- API request and response shapes
- Form state
- Domain statuses
- Configuration
- Permissions
- Events and actions
- Data returned from third-party services

These are places where unclear shapes become real bugs. If a backend field can be missing, the frontend should know that. If a payment can be in only five states, the code should not behave as if any string is acceptable. If a form has conditional sections, the state should describe that clearly.

TypeScript also changes refactoring. When types are useful and not just decorative, they give you confidence to move code around. You can rename fields, split functions, tighten contracts, and let the compiler show you the places that still need attention.

That is a very different feeling from the JavaScript I was writing when ES6 still felt new.

## JavaScript became the easy part

After enough years building production software, knowing how destructuring works is not usually what makes a JavaScript application difficult.

The difficult parts are around the language:

- State
- Architecture
- API contracts
- Authentication
- Authorization
- Native platform behavior
- Persistence
- Build systems
- Dependencies
- Observability
- Testing
- Releases
- Performance
- Security
- Real users doing unexpected things

JavaScript is the language connecting many of those decisions.

That is why my relationship with the language has changed. I still enjoy the language, but I no longer see "modern JavaScript" as mainly a syntax question. Modern JavaScript work is often systems work wearing a JavaScript shirt.

In a banking app, the hard part is not whether you used an arrow function. It is whether authentication is reliable, sensitive flows are handled carefully, data is correct, errors are recoverable, and the app behaves consistently across platforms.

In a lending product, the hard part is not whether the code uses destructuring. It is whether a long application flow can capture complicated borrower data, validate it, transform it, submit it, and keep different systems in sync.

In a marketplace, the hard part is not whether the code uses `map`. It is whether bidding, payments, notifications, seller activity, and user trust all work together.

The language got easier. The systems around it got bigger.

## Frameworks change, fundamentals compound

React, React Native, Node.js, Astro, GraphQL, serverless platforms, bundlers, testing tools, and deployment workflows have all changed the way I build with JavaScript.

They matter. Tools shape the work.

But the fundamentals have kept paying off through every tool change:

- How closures work
- How references behave
- How arrays and objects are copied
- How promises are scheduled
- How the browser renders
- How events move through the system
- How modules are loaded
- How data flows through a program

Frameworks can hide some of this for a while, but they do not remove it. When something breaks, performance gets weird, state becomes stale, or a component renders more than expected, the fundamentals come back.

This is why I would still tell someone to learn JavaScript properly before trying to learn the entire ecosystem.

The ecosystem is too large to "finish." There is always another framework, another rendering model, another build tool, another state library, another pattern. Chasing all of it is exhausting.

The fundamentals compound more quietly. They make each new tool easier to understand because you can see what problem it is solving instead of treating it like magic.

## What I care about now

The questions I ask about JavaScript code today are different from the ones I asked when I was learning ES6.

I care less about whether the code looks modern at first glance and more about whether it can survive real product work.

Can someone understand this without knowing why I thought it was clever?

Is this abstraction actually removing complexity, or did I just move the complexity into a new file?

Are failure states obvious?

Does the type system explain the code or fight against it?

Is state living in the right place?

Can this function be tested without recreating the whole application?

Will changing this six months from now be painful?

Is the simple implementation enough?

These questions are less exciting than learning new syntax, but they are the questions that keep codebases healthy.

Experience has made me more interested in boring decisions. Clear names. Smaller functions. Fewer hidden side effects. Types that describe real boundaries. Components that do not own more state than they should. API contracts that do not require guesswork. Error handling that is visible instead of accidental.

None of this is unique to JavaScript. But JavaScript is where I have learned many of these lessons because it sits in so many parts of a modern product.

## What I would tell someone learning JavaScript today

If someone were learning JavaScript now, I would not tell them to start by learning every framework or tool.

I would tell them to learn the language well enough that frameworks make sense.

Learn functions, objects, arrays, modules, promises, and async execution. Learn how the browser works. Learn how data moves between the client and server. Build small things. Then build slightly messier things. Read code that other people wrote. Debug problems instead of only following tutorials.

Once the JavaScript underneath it makes sense, learn TypeScript. Not as a badge, but as a way to describe contracts and make change safer.

Pick a framework when you need one. React is useful. So are many other tools. But no framework removes the need to understand the language, the runtime, and the product you are building.

Most importantly, do not turn everything you learn into a permanent rule.

That is the part I would say to my 2016 self too.

It is fine to have strong opinions while you are learning. In some ways, strong opinions help you move. They give you a direction. But over time, the useful opinions become more contextual.

Use `map` when mapping. Use `filter` when filtering. Use a loop when the loop is clearer. Use TypeScript where it makes the boundary sharper. Use a class when it fits. Use a function when it is enough. Choose the boring version when the boring version is easier to understand.

I do not feel embarrassed by the old ES6 article. I am glad it exists. It shows what I understood at that point, and it reminds me that learning is supposed to leave evidence behind.

The more interesting evidence of experience is not "look how much more JavaScript I know now."

It is that I have fewer absolute rules about how JavaScript should be written.

And, usually, better reasons for the ones I still keep.
