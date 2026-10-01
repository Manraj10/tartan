// Shared between main, preload and renderer. Keep this dependency-free.

/**
 * One rung of the ladder. The list ships with the app rather than living in the data folder:
 * it is curriculum, not the user's data — their progress (leetcode.json) is the data.
 */
export interface LadderStep {
  slug: string
  title: string
  difficulty: 'Easy' | 'Medium' | 'Hard'
  topic: string
  /** How many of Google/Amazon/Meta/Microsoft/Apple/Netflix/Uber ask it (0–7), from the free
      company-wise dataset (github.com/liquidslr/leetcode-company-wise-problems). */
  asks: number
  /** Same problem on a free mirror (neetcode.io), for the days leetcode.com will not load. */
  alt?: string
  /**
   * The companies that ask it, by name, ordered by how many independent GitHub datasets
   * corroborate each one — liquidslr (2026), krishnadey30, hxu296 (2022), snehasishroy.
   * A name here means at least one dataset lists the problem under that company.
   */
  companies?: string[]
  /**
   * Paywalled on leetcode.com. Six of the Blind 75 are — which is why they were missing until
   * the ladder was completed. The card opens `alt` for these, where the problem is free.
   */
  premium?: boolean
}

/** Progress. Slug → YYYY-MM-DD it was solved. Lives in the data folder as leetcode.json. */
export interface LeetcodeState {
  done: Record<string, string>
}

export const problemUrl = (slug: string): string => `https://leetcode.com/problems/${slug}/`

/** The link a click should open: the free mirror first — every rung has one, LeetCode is the
    fallback — because the mirror is never paywalled and never "not working right now". */
export const openUrl = (p: LadderStep): string => p.alt ?? problemUrl(p.slug)

const pad2 = (n: number): string => String(n).padStart(2, '0')
const ymdOf = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

/** Days-in-a-row with a solve. Today only counts once something is solved, so a fresh morning
    does not read as a broken streak. */
export function streakOf(done: Record<string, string>): number {
  const days = new Set(Object.values(done))
  const d = new Date()
  if (!days.has(ymdOf(d))) d.setDate(d.getDate() - 1)
  let n = 0
  while (days.has(ymdOf(d))) {
    n++
    d.setDate(d.getDate() - 1)
  }
  return n
}

/**
 * The ladder: 138 problems, topic-by-topic in learning order, Easy before Medium inside each
 * topic — and a strict superset of Blind 75 (all 75) plus 123 of the NeetCode 150. Every slug was
 * verified against leetcode.com's own GraphQL API; every company name is corroborated across up to
 * five independent GitHub datasets; every mirror link was checked against ground truth. Do not
 * reorder casually — the order IS the curriculum.
 */
export const LADDER: LadderStep[] = [
  { slug: 'contains-duplicate', title: "Contains Duplicate", difficulty: 'Easy', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/duplicate-integer", companies: ["Amazon","Microsoft","Apple","Google","Meta"] },
  { slug: 'valid-anagram', title: "Valid Anagram", difficulty: 'Easy', topic: "Arrays & Hashing", asks: 7, alt: "https://neetcode.io/problems/is-anagram", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'two-sum', title: "Two Sum", difficulty: 'Easy', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/two-integer-sum", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'majority-element', title: "Majority Element", difficulty: 'Easy', topic: "Arrays & Hashing", asks: 4, alt: "https://neetcode.io/problems/majority-element", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'ransom-note', title: "Ransom Note", difficulty: 'Easy', topic: "Arrays & Hashing", asks: 5, alt: "https://neetcode.io/problems/ransom-note", companies: ["Apple","Google","Amazon","Microsoft","Meta"] },
  { slug: 'group-anagrams', title: "Group Anagrams", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/anagram-groups", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'top-k-frequent-elements', title: "Top K Frequent Elements", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 7, alt: "https://neetcode.io/problems/top-k-elements-in-list", companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'product-of-array-except-self', title: "Product of Array Except Self", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/products-of-array-discluding-self", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'valid-sudoku', title: "Valid Sudoku", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/valid-sudoku", companies: ["Amazon","Meta","Microsoft","Apple","Uber"] },
  { slug: 'subarray-sum-equals-k', title: "Subarray Sum Equals K", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/subarray-sum-equals-k", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'longest-consecutive-sequence', title: "Longest Consecutive Sequence", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/longest-consecutive-sequence", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'encode-and-decode-strings', title: "Encode and Decode Strings", difficulty: 'Medium', topic: "Arrays & Hashing", asks: 4, alt: "https://neetcode.io/problems/string-encode-and-decode", premium: true, companies: ["Google","Amazon","Meta","Microsoft"] },
  { slug: 'first-missing-positive', title: "First Missing Positive", difficulty: 'Hard', topic: "Arrays & Hashing", asks: 6, alt: "https://neetcode.io/problems/first-missing-positive", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'valid-palindrome', title: "Valid Palindrome", difficulty: 'Easy', topic: "Two Pointers", asks: 6, alt: "https://neetcode.io/problems/is-palindrome", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'remove-duplicates-from-sorted-array', title: "Remove Duplicates from Sorted Array", difficulty: 'Easy', topic: "Two Pointers", asks: 6, alt: "https://neetcode.io/problems/remove-duplicates-from-sorted-array", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'merge-sorted-array', title: "Merge Sorted Array", difficulty: 'Easy', topic: "Two Pointers", asks: 5, alt: "https://neetcode.io/problems/merge-sorted-array", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'move-zeroes', title: "Move Zeroes", difficulty: 'Easy', topic: "Two Pointers", asks: 6, alt: "https://neetcode.io/problems/move-zeroes", companies: ["Amazon","Meta","Microsoft","Apple","Uber"] },
  { slug: 'two-sum-ii-input-array-is-sorted', title: "Two Sum II - Input Array Is Sorted", difficulty: 'Medium', topic: "Two Pointers", asks: 5, alt: "https://neetcode.io/problems/two-integer-sum-ii", companies: ["Google","Amazon","Microsoft","Apple","Meta"] },
  { slug: '3sum', title: "3Sum", difficulty: 'Medium', topic: "Two Pointers", asks: 5, alt: "https://neetcode.io/problems/three-integer-sum", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'container-with-most-water', title: "Container With Most Water", difficulty: 'Medium', topic: "Two Pointers", asks: 6, alt: "https://neetcode.io/problems/max-water-container", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'trapping-rain-water', title: "Trapping Rain Water", difficulty: 'Hard', topic: "Two Pointers", asks: 6, alt: "https://neetcode.io/problems/trapping-rain-water", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'best-time-to-buy-and-sell-stock', title: "Best Time to Buy and Sell Stock", difficulty: 'Easy', topic: "Sliding Window", asks: 6, alt: "https://neetcode.io/problems/buy-and-sell-crypto", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'maximum-average-subarray-i', title: "Maximum Average Subarray I", difficulty: 'Easy', topic: "Sliding Window", asks: 5, alt: "https://leetcode.doocs.org/en/lc/643/", companies: ["Google","Meta","Microsoft","Amazon","Uber"] },
  { slug: 'longest-substring-without-repeating-characters', title: "Longest Substring Without Repeating Characters", difficulty: 'Medium', topic: "Sliding Window", asks: 7, alt: "https://neetcode.io/problems/longest-substring-without-duplicates", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'minimum-size-subarray-sum', title: "Minimum Size Subarray Sum", difficulty: 'Medium', topic: "Sliding Window", asks: 5, alt: "https://neetcode.io/problems/minimum-size-subarray-sum", companies: ["Google","Meta","Microsoft","Amazon","Apple"] },
  { slug: 'longest-repeating-character-replacement', title: "Longest Repeating Character Replacement", difficulty: 'Medium', topic: "Sliding Window", asks: 5, alt: "https://neetcode.io/problems/longest-repeating-substring-with-replacement", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'permutation-in-string', title: "Permutation in String", difficulty: 'Medium', topic: "Sliding Window", asks: 5, alt: "https://neetcode.io/problems/permutation-string", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'minimum-window-substring', title: "Minimum Window Substring", difficulty: 'Hard', topic: "Sliding Window", asks: 6, alt: "https://neetcode.io/problems/minimum-window-with-characters", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'sliding-window-maximum', title: "Sliding Window Maximum", difficulty: 'Hard', topic: "Sliding Window", asks: 6, alt: "https://neetcode.io/problems/sliding-window-maximum", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'valid-parentheses', title: "Valid Parentheses", difficulty: 'Easy', topic: "Stack", asks: 6, alt: "https://neetcode.io/problems/validate-parentheses", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'implement-queue-using-stacks', title: "Implement Queue using Stacks", difficulty: 'Easy', topic: "Stack", asks: 5, alt: "https://neetcode.io/problems/implement-queue-using-stacks", companies: ["Google","Amazon","Microsoft","Apple","Meta"] },
  { slug: 'min-stack', title: "Min Stack", difficulty: 'Medium', topic: "Stack", asks: 6, alt: "https://neetcode.io/problems/minimum-stack", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'evaluate-reverse-polish-notation', title: "Evaluate Reverse Polish Notation", difficulty: 'Medium', topic: "Stack", asks: 5, alt: "https://neetcode.io/problems/evaluate-reverse-polish-notation", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'daily-temperatures', title: "Daily Temperatures", difficulty: 'Medium', topic: "Stack", asks: 4, alt: "https://neetcode.io/problems/daily-temperatures", companies: ["Amazon","Microsoft","Google","Meta","Uber"] },
  { slug: 'generate-parentheses', title: "Generate Parentheses", difficulty: 'Medium', topic: "Stack", asks: 6, alt: "https://neetcode.io/problems/generate-parentheses", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'car-fleet', title: "Car Fleet", difficulty: 'Medium', topic: "Stack", asks: 4, alt: "https://neetcode.io/problems/car-fleet", companies: ["Google","Amazon","Meta","Microsoft"] },
  { slug: 'largest-rectangle-in-histogram', title: "Largest Rectangle in Histogram", difficulty: 'Hard', topic: "Stack", asks: 6, alt: "https://neetcode.io/problems/largest-rectangle-in-histogram", companies: ["Amazon","Meta","Microsoft","Google","Uber"] },
  { slug: 'binary-search', title: "Binary Search", difficulty: 'Easy', topic: "Binary Search", asks: 5, alt: "https://neetcode.io/problems/binary-search", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'search-insert-position', title: "Search Insert Position", difficulty: 'Easy', topic: "Binary Search", asks: 4, alt: "https://neetcode.io/problems/search-insert-position", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'first-bad-version', title: "First Bad Version", difficulty: 'Easy', topic: "Binary Search", asks: 5, alt: "https://leetcode.doocs.org/en/lc/278/", companies: ["Google","Meta","Amazon","Microsoft","Apple"] },
  { slug: 'search-a-2d-matrix', title: "Search a 2D Matrix", difficulty: 'Medium', topic: "Binary Search", asks: 6, alt: "https://neetcode.io/problems/search-2d-matrix", companies: ["Amazon","Meta","Microsoft","Google","Apple"] },
  { slug: 'koko-eating-bananas', title: "Koko Eating Bananas", difficulty: 'Medium', topic: "Binary Search", asks: 7, alt: "https://neetcode.io/problems/eating-bananas", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'find-minimum-in-rotated-sorted-array', title: "Find Minimum in Rotated Sorted Array", difficulty: 'Medium', topic: "Binary Search", asks: 6, alt: "https://neetcode.io/problems/find-minimum-in-rotated-sorted-array", companies: ["Amazon","Meta","Microsoft","Uber","Google"] },
  { slug: 'search-in-rotated-sorted-array', title: "Search in Rotated Sorted Array", difficulty: 'Medium', topic: "Binary Search", asks: 6, alt: "https://neetcode.io/problems/find-target-in-rotated-sorted-array", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'median-of-two-sorted-arrays', title: "Median of Two Sorted Arrays", difficulty: 'Hard', topic: "Binary Search", asks: 6, alt: "https://neetcode.io/problems/median-of-two-sorted-arrays", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'reverse-linked-list', title: "Reverse Linked List", difficulty: 'Easy', topic: "Linked List", asks: 6, alt: "https://neetcode.io/problems/reverse-a-linked-list", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'merge-two-sorted-lists', title: "Merge Two Sorted Lists", difficulty: 'Easy', topic: "Linked List", asks: 5, alt: "https://neetcode.io/problems/merge-two-sorted-linked-lists", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'linked-list-cycle', title: "Linked List Cycle", difficulty: 'Easy', topic: "Linked List", asks: 4, alt: "https://neetcode.io/problems/linked-list-cycle-detection", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'remove-nth-node-from-end-of-list', title: "Remove Nth Node From End of List", difficulty: 'Medium', topic: "Linked List", asks: 5, alt: "https://neetcode.io/problems/remove-node-from-end-of-linked-list", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'reorder-list', title: "Reorder List", difficulty: 'Medium', topic: "Linked List", asks: 5, alt: "https://neetcode.io/problems/reorder-linked-list", companies: ["Amazon","Meta","Microsoft","Google","Apple"] },
  { slug: 'add-two-numbers', title: "Add Two Numbers", difficulty: 'Medium', topic: "Linked List", asks: 6, alt: "https://neetcode.io/problems/add-two-numbers", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'copy-list-with-random-pointer', title: "Copy List with Random Pointer", difficulty: 'Medium', topic: "Linked List", asks: 5, alt: "https://neetcode.io/problems/copy-linked-list-with-random-pointer", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'find-the-duplicate-number', title: "Find the Duplicate Number", difficulty: 'Medium', topic: "Linked List", asks: 4, alt: "https://neetcode.io/problems/find-duplicate-integer", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'lru-cache', title: "LRU Cache", difficulty: 'Medium', topic: "Linked List", asks: 7, alt: "https://neetcode.io/problems/lru-cache", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'merge-k-sorted-lists', title: "Merge k Sorted Lists", difficulty: 'Hard', topic: "Linked List", asks: 6, alt: "https://neetcode.io/problems/merge-k-sorted-linked-lists", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'invert-binary-tree', title: "Invert Binary Tree", difficulty: 'Easy', topic: "Trees", asks: 4, alt: "https://neetcode.io/problems/invert-a-binary-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'maximum-depth-of-binary-tree', title: "Maximum Depth of Binary Tree", difficulty: 'Easy', topic: "Trees", asks: 6, alt: "https://neetcode.io/problems/depth-of-binary-tree", companies: ["Google","Amazon","Meta","Apple","Microsoft"] },
  { slug: 'same-tree', title: "Same Tree", difficulty: 'Easy', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/same-binary-tree", companies: ["Google","Amazon","Meta","Apple","Microsoft"] },
  { slug: 'diameter-of-binary-tree', title: "Diameter of Binary Tree", difficulty: 'Easy', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/binary-tree-diameter", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'balanced-binary-tree', title: "Balanced Binary Tree", difficulty: 'Easy', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/balanced-binary-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'subtree-of-another-tree', title: "Subtree of Another Tree", difficulty: 'Easy', topic: "Trees", asks: 4, alt: "https://neetcode.io/problems/subtree-of-a-binary-tree", companies: ["Google","Amazon","Meta","Microsoft"] },
  { slug: 'binary-tree-level-order-traversal', title: "Binary Tree Level Order Traversal", difficulty: 'Medium', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/level-order-traversal-of-binary-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'binary-tree-right-side-view', title: "Binary Tree Right Side View", difficulty: 'Medium', topic: "Trees", asks: 6, alt: "https://neetcode.io/problems/binary-tree-right-side-view", companies: ["Amazon","Meta","Microsoft","Apple","Uber"] },
  { slug: 'count-good-nodes-in-binary-tree', title: "Count Good Nodes in Binary Tree", difficulty: 'Medium', topic: "Trees", asks: 4, alt: "https://neetcode.io/problems/count-good-nodes-in-binary-tree", companies: ["Microsoft","Google","Amazon","Meta"] },
  { slug: 'construct-binary-tree-from-preorder-and-inorder-traversal', title: "Construct Binary Tree from Preorder and Inorder Traversal", difficulty: 'Medium', topic: "Trees", asks: 4, alt: "https://neetcode.io/problems/binary-tree-from-preorder-and-inorder-traversal", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'lowest-common-ancestor-of-a-binary-search-tree', title: "Lowest Common Ancestor of a Binary Search Tree", difficulty: 'Medium', topic: "Trees", asks: 4, alt: "https://neetcode.io/problems/lowest-common-ancestor-in-binary-search-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'validate-binary-search-tree', title: "Validate Binary Search Tree", difficulty: 'Medium', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/valid-binary-search-tree", companies: ["Amazon","Meta","Microsoft","Google","Apple"] },
  { slug: 'kth-smallest-element-in-a-bst', title: "Kth Smallest Element in a BST", difficulty: 'Medium', topic: "Trees", asks: 5, alt: "https://neetcode.io/problems/kth-smallest-integer-in-bst", companies: ["Amazon","Meta","Microsoft","Uber","Google"] },
  { slug: 'binary-tree-maximum-path-sum', title: "Binary Tree Maximum Path Sum", difficulty: 'Hard', topic: "Trees", asks: 6, alt: "https://neetcode.io/problems/binary-tree-maximum-path-sum", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'serialize-and-deserialize-binary-tree', title: "Serialize and Deserialize Binary Tree", difficulty: 'Hard', topic: "Trees", asks: 6, alt: "https://neetcode.io/problems/serialize-and-deserialize-binary-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'kth-largest-element-in-a-stream', title: "Kth Largest Element in a Stream", difficulty: 'Easy', topic: "Heap / Priority Queue", asks: 4, alt: "https://neetcode.io/problems/kth-largest-integer-in-a-stream", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'last-stone-weight', title: "Last Stone Weight", difficulty: 'Easy', topic: "Heap / Priority Queue", asks: 5, alt: "https://neetcode.io/problems/last-stone-weight", companies: ["Amazon","Google","Meta","Microsoft","Uber"] },
  { slug: 'k-closest-points-to-origin', title: "K Closest Points to Origin", difficulty: 'Medium', topic: "Heap / Priority Queue", asks: 5, alt: "https://neetcode.io/problems/k-closest-points-to-origin", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'kth-largest-element-in-an-array', title: "Kth Largest Element in an Array", difficulty: 'Medium', topic: "Heap / Priority Queue", asks: 6, alt: "https://neetcode.io/problems/kth-largest-element-in-an-array", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'task-scheduler', title: "Task Scheduler", difficulty: 'Medium', topic: "Heap / Priority Queue", asks: 6, alt: "https://neetcode.io/problems/task-scheduling", companies: ["Amazon","Meta","Microsoft","Uber","Google"] },
  { slug: 'find-median-from-data-stream', title: "Find Median from Data Stream", difficulty: 'Hard', topic: "Heap / Priority Queue", asks: 6, alt: "https://neetcode.io/problems/find-median-in-a-data-stream", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'subsets', title: "Subsets", difficulty: 'Medium', topic: "Backtracking", asks: 5, alt: "https://neetcode.io/problems/subsets", companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'letter-combinations-of-a-phone-number', title: "Letter Combinations of a Phone Number", difficulty: 'Medium', topic: "Backtracking", asks: 6, alt: "https://neetcode.io/problems/combinations-of-a-phone-number", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'permutations', title: "Permutations", difficulty: 'Medium', topic: "Backtracking", asks: 6, alt: "https://neetcode.io/problems/permutations", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'combination-sum', title: "Combination Sum", difficulty: 'Medium', topic: "Backtracking", asks: 6, alt: "https://neetcode.io/problems/combination-target-sum", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'combination-sum-ii', title: "Combination Sum II", difficulty: 'Medium', topic: "Backtracking", asks: 4, alt: "https://neetcode.io/problems/combination-target-sum-ii", companies: ["Amazon","Meta","Microsoft","Google","Uber"] },
  { slug: 'subsets-ii', title: "Subsets II", difficulty: 'Medium', topic: "Backtracking", asks: 4, alt: "https://neetcode.io/problems/subsets-ii", companies: ["Amazon","Meta","Microsoft","Google","Apple"] },
  { slug: 'word-search', title: "Word Search", difficulty: 'Medium', topic: "Backtracking", asks: 7, alt: "https://neetcode.io/problems/search-for-word", companies: ["Amazon","Meta","Microsoft","Uber","Google"] },
  { slug: 'palindrome-partitioning', title: "Palindrome Partitioning", difficulty: 'Medium', topic: "Backtracking", asks: 4, alt: "https://neetcode.io/problems/palindrome-partitioning", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'n-queens', title: "N-Queens", difficulty: 'Hard', topic: "Backtracking", asks: 4, alt: "https://neetcode.io/problems/n-queens", companies: ["Amazon","Meta","Microsoft","Google","Apple"] },
  { slug: 'implement-trie-prefix-tree', title: "Implement Trie (Prefix Tree)", difficulty: 'Medium', topic: "Tries", asks: 6, alt: "https://neetcode.io/problems/implement-prefix-tree", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'design-add-and-search-words-data-structure', title: "Design Add and Search Words Data Structure", difficulty: 'Medium', topic: "Tries", asks: 5, alt: "https://neetcode.io/problems/design-word-search-data-structure", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'word-search-ii', title: "Word Search II", difficulty: 'Hard', topic: "Tries", asks: 6, alt: "https://neetcode.io/problems/search-for-word-ii", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'flood-fill', title: "Flood Fill", difficulty: 'Easy', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/flood-fill", companies: ["Google","Amazon","Uber","Meta","Microsoft"] },
  { slug: 'number-of-islands', title: "Number of Islands", difficulty: 'Medium', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/count-number-of-islands", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'max-area-of-island', title: "Max Area of Island", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/max-area-of-island", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'clone-graph', title: "Clone Graph", difficulty: 'Medium', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/clone-graph", companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'rotting-oranges', title: "Rotting Oranges", difficulty: 'Medium', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/rotting-fruit", companies: ["Amazon","Microsoft","Google","Meta","Apple"] },
  { slug: 'pacific-atlantic-water-flow', title: "Pacific Atlantic Water Flow", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/pacific-atlantic-water-flow", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'surrounded-regions', title: "Surrounded Regions", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/surrounded-regions", companies: ["Google","Uber","Amazon","Meta","Microsoft"] },
  { slug: 'course-schedule', title: "Course Schedule", difficulty: 'Medium', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/course-schedule", companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'course-schedule-ii', title: "Course Schedule II", difficulty: 'Medium', topic: "Graphs", asks: 7, alt: "https://neetcode.io/problems/course-schedule-ii", companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'redundant-connection', title: "Redundant Connection", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/redundant-connection", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'accounts-merge', title: "Accounts Merge", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/accounts-merge", companies: ["Google","Meta","Amazon","Microsoft","Apple"] },
  { slug: 'graph-valid-tree', title: "Graph Valid Tree", difficulty: 'Medium', topic: "Graphs", asks: 5, alt: "https://neetcode.io/problems/valid-tree", premium: true, companies: ["Google","Amazon","Meta","Microsoft","Uber"] },
  { slug: 'number-of-connected-components-in-an-undirected-graph', title: "Number of Connected Components in an Undirected Graph", difficulty: 'Medium', topic: "Graphs", asks: 3, alt: "https://neetcode.io/problems/count-connected-components", premium: true, companies: ["Google","Amazon","Meta"] },
  { slug: 'word-ladder', title: "Word Ladder", difficulty: 'Hard', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/word-ladder", companies: ["Amazon","Meta","Microsoft","Apple","Google"] },
  { slug: 'alien-dictionary', title: "Alien Dictionary", difficulty: 'Hard', topic: "Graphs", asks: 6, alt: "https://neetcode.io/problems/foreign-dictionary", premium: true, companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'climbing-stairs', title: "Climbing Stairs", difficulty: 'Easy', topic: "1-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/climbing-stairs", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'min-cost-climbing-stairs', title: "Min Cost Climbing Stairs", difficulty: 'Easy', topic: "1-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/min-cost-climbing-stairs", companies: ["Amazon","Google","Meta","Microsoft"] },
  { slug: 'house-robber', title: "House Robber", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 6, alt: "https://neetcode.io/problems/house-robber", companies: ["Google","Amazon","Microsoft","Apple","Meta"] },
  { slug: 'house-robber-ii', title: "House Robber II", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/house-robber-ii", companies: ["Google","Amazon","Microsoft","Meta","Apple"] },
  { slug: 'maximum-product-subarray', title: "Maximum Product Subarray", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/maximum-product-subarray", companies: ["Google","Amazon","Microsoft","Meta","Uber"] },
  { slug: 'coin-change', title: "Coin Change", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 6, alt: "https://neetcode.io/problems/coin-change", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'longest-increasing-subsequence', title: "Longest Increasing Subsequence", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/longest-increasing-subsequence", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'word-break', title: "Word Break", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 7, alt: "https://neetcode.io/problems/word-break", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'decode-ways', title: "Decode Ways", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/decode-ways", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'partition-equal-subset-sum', title: "Partition Equal Subset Sum", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/partition-equal-subset-sum", companies: ["Google","Meta","Microsoft","Amazon","Apple"] },
  { slug: 'longest-palindromic-substring', title: "Longest Palindromic Substring", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 6, alt: "https://neetcode.io/problems/longest-palindromic-substring", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'palindromic-substrings', title: "Palindromic Substrings", difficulty: 'Medium', topic: "1-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/palindromic-substrings", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'unique-paths', title: "Unique Paths", difficulty: 'Medium', topic: "2-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/count-paths", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'longest-common-subsequence', title: "Longest Common Subsequence", difficulty: 'Medium', topic: "2-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/longest-common-subsequence", companies: ["Amazon","Google","Meta","Microsoft","Apple"] },
  { slug: 'coin-change-ii', title: "Coin Change II", difficulty: 'Medium', topic: "2-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/coin-change-ii", companies: ["Google","Amazon","Meta","Microsoft"] },
  { slug: 'best-time-to-buy-and-sell-stock-with-cooldown', title: "Best Time to Buy and Sell Stock with Cooldown", difficulty: 'Medium', topic: "2-D Dynamic Programming", asks: 4, alt: "https://neetcode.io/problems/buy-and-sell-crypto-with-cooldown", companies: ["Google","Amazon","Apple","Microsoft","Meta"] },
  { slug: 'edit-distance', title: "Edit Distance", difficulty: 'Medium', topic: "2-D Dynamic Programming", asks: 5, alt: "https://neetcode.io/problems/edit-distance", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'maximum-subarray', title: "Maximum Subarray", difficulty: 'Medium', topic: "Greedy", asks: 6, alt: "https://neetcode.io/problems/maximum-subarray", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'jump-game', title: "Jump Game", difficulty: 'Medium', topic: "Greedy", asks: 5, alt: "https://neetcode.io/problems/jump-game", companies: ["Google","Amazon","Meta","Apple","Microsoft"] },
  { slug: 'jump-game-ii', title: "Jump Game II", difficulty: 'Medium', topic: "Greedy", asks: 5, alt: "https://neetcode.io/problems/jump-game-ii", companies: ["Google","Amazon","Microsoft","Apple","Meta"] },
  { slug: 'gas-station', title: "Gas Station", difficulty: 'Medium', topic: "Greedy", asks: 5, alt: "https://neetcode.io/problems/gas-station", companies: ["Amazon","Microsoft","Google","Apple","Meta"] },
  { slug: 'meeting-rooms', title: "Meeting Rooms", difficulty: 'Easy', topic: "Intervals", asks: 6, alt: "https://neetcode.io/problems/meeting-schedule", premium: true, companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'merge-intervals', title: "Merge Intervals", difficulty: 'Medium', topic: "Intervals", asks: 7, alt: "https://neetcode.io/problems/merge-intervals", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'insert-interval', title: "Insert Interval", difficulty: 'Medium', topic: "Intervals", asks: 6, alt: "https://neetcode.io/problems/insert-new-interval", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'non-overlapping-intervals', title: "Non-overlapping Intervals", difficulty: 'Medium', topic: "Intervals", asks: 6, alt: "https://neetcode.io/problems/non-overlapping-intervals", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'minimum-number-of-arrows-to-burst-balloons', title: "Minimum Number of Arrows to Burst Balloons", difficulty: 'Medium', topic: "Intervals", asks: 3, alt: "https://leetcode.doocs.org/en/lc/452/", companies: ["Google","Amazon","Meta","Microsoft"] },
  { slug: 'meeting-rooms-ii', title: "Meeting Rooms II", difficulty: 'Medium', topic: "Intervals", asks: 7, alt: "https://neetcode.io/problems/meeting-schedule-ii", premium: true, companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'rotate-image', title: "Rotate Image", difficulty: 'Medium', topic: "Math & Geometry", asks: 6, alt: "https://neetcode.io/problems/rotate-matrix", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'spiral-matrix', title: "Spiral Matrix", difficulty: 'Medium', topic: "Math & Geometry", asks: 6, alt: "https://neetcode.io/problems/spiral-matrix", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'set-matrix-zeroes', title: "Set Matrix Zeroes", difficulty: 'Medium', topic: "Math & Geometry", asks: 5, alt: "https://neetcode.io/problems/set-zeroes-in-matrix", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'number-of-1-bits', title: "Number of 1 Bits", difficulty: 'Easy', topic: "Bit Manipulation", asks: 5, alt: "https://neetcode.io/problems/number-of-one-bits", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'counting-bits', title: "Counting Bits", difficulty: 'Easy', topic: "Bit Manipulation", asks: 5, alt: "https://neetcode.io/problems/counting-bits", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'reverse-bits', title: "Reverse Bits", difficulty: 'Easy', topic: "Bit Manipulation", asks: 5, alt: "https://neetcode.io/problems/reverse-bits", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'missing-number', title: "Missing Number", difficulty: 'Easy', topic: "Bit Manipulation", asks: 5, alt: "https://neetcode.io/problems/missing-number", companies: ["Google","Amazon","Meta","Microsoft","Apple"] },
  { slug: 'sum-of-two-integers', title: "Sum of Two Integers", difficulty: 'Medium', topic: "Bit Manipulation", asks: 4, alt: "https://neetcode.io/problems/sum-of-two-integers", companies: ["Google","Amazon","Meta","Microsoft"] },
]
