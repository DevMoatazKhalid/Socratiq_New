"""
Representative lessons for the comprehension-question regression suite and the live evaluation script
(scripts/eval_comprehension_questions.py).

Each lesson carries: the assignment fields the backend sends, retrieved material, the student's submitted work, illustrative GOOD
questions per step (used by the scripted model in unit tests, never hard-coded into the product), and BAD questions that the quality
gate must reject. The kidney case is the production failure that started this work.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Lesson:
    key: str
    title: str
    subject_area: str
    instructions: str
    material: tuple[str, ...]
    concepts: tuple[str, ...]
    student_work: str
    is_programming: bool = False
    good: dict = field(default_factory=dict)        # {"EXPLAIN": q, "MODIFY": q, "TRANSFER": q}
    bad: tuple[str, ...] = ()                       # questions the deterministic gate must reject for this lesson


KIDNEY_REGRESSION = "Why does anatomy of the kidney work in your solution?"

LESSONS: tuple[Lesson, ...] = (
    Lesson(
        key="anatomy_kidney",
        title="Anatomy and Physiology of the Kidney",
        subject_area="human anatomy",
        instructions="Describe the main structures of the kidney and explain how the nephron forms urine. Write a short essay.",
        material=(
            "The kidney has three main regions: the renal cortex, the renal medulla and the renal pelvis. The functional unit of the "
            "kidney is the nephron; each kidney contains about one million nephrons.",
            "Urine formation has three steps. Filtration: blood pressure forces water and small solutes out of the glomerulus into "
            "Bowman's capsule. Reabsorption: the renal tubule returns water, glucose and salts to the blood. Secretion: the tubule "
            "moves wastes such as hydrogen ions from the blood into the filtrate.",
        ),
        concepts=("anatomy of the kidney", "nephron", "urine formation"),
        student_work=("The kidney is made of the cortex, medulla and pelvis. Nephrons filter the blood in the glomerulus and the tubule "
                      "takes back useful things like glucose and water, so what is left becomes urine."),
        good={
            "EXPLAIN": "What are the main structures of the kidney, and what is the role of each?",
            "MODIFY": "How does the nephron contribute to the formation of urine?",
            "TRANSFER": "What would happen to urine formation if the glomerulus could no longer filter blood effectively?",
        },
        bad=(
            KIDNEY_REGRESSION,
            "How does the anatomy of the kidney function in your answer?",
            "Why does the anatomy of the kidney work?",
            "Why does nephron work in your code?",
            "What changes if anatomy of the kidney is modified or reversed?",
            "Where else could you apply anatomy of the kidney?",
        ),
    ),
    Lesson(
        key="math_eigen",
        title="Eigenvalues and Eigenvectors",
        subject_area="linear algebra",
        instructions="Find the eigenvalues of A = [[2, 1], [1, 2]] and an eigenvector for each. Show your working.",
        material=(
            "A non-zero vector v is an eigenvector of a square matrix A if Av = λv for some scalar λ, called the eigenvalue. "
            "Eigenvalues are the roots of the characteristic equation det(A − λI) = 0.",
            "For a diagonal matrix the eigenvalues are the diagonal entries. Eigenvectors for distinct eigenvalues are linearly independent.",
        ),
        concepts=("eigenvalues", "characteristic equation", "eigenvectors"),
        student_work="det(A - λI) = (2-λ)^2 - 1 = 0 so λ = 1 or λ = 3. For λ = 3: v = (1, 1). For λ = 1: v = (1, -1).",
        good={
            "EXPLAIN": "What does it mean for a vector v to be an eigenvector of a matrix A?",
            "MODIFY": "Why must det(A − λI) equal zero for λ to be an eigenvalue of A?",
            "TRANSFER": "What are the eigenvalues of a diagonal matrix with entries 4 and 7, and why?",
        },
        bad=("Why does eigenvalues work in your solution?", "Why does linear algebra work in your derivation?"),
    ),
    Lesson(
        key="programming_ds",
        title="Python Data Structures: Lists and Dictionaries",
        subject_area="programming",
        instructions="Write a function count_words(text) that returns a dictionary mapping each word to how many times it appears.",
        material=(
            "A list stores items in order; finding a value requires scanning the items one by one (O(n)). A dictionary maps keys to "
            "values using a hash table, so looking up a key takes constant time on average (O(1)).",
            "dict.get(key, default) returns the default when the key is missing, which avoids a KeyError.",
        ),
        concepts=("dictionaries", "hash table lookup", "lists"),
        student_work="def count_words(text):\n    counts = {}\n    for w in text.split():\n        counts[w] = counts.get(w, 0) + 1\n    return counts",
        is_programming=True,
        good={
            "EXPLAIN": "Why does your function use counts.get(w, 0) instead of counts[w] when adding a new word?",
            "MODIFY": "Why is looking up a key in a dictionary faster on average than searching a list for a value?",
            "TRANSFER": "How would you use a dictionary to find the first repeated character in a string?",
        },
        bad=("Why does python data structures work in your solution?", "Which of the following is a dictionary? A) [] B) {} C) ()?"),
    ),
    Lesson(
        key="physics_newton",
        title="Newton's Second Law",
        subject_area="physics",
        instructions="A 2 kg cart is pushed with a net force of 10 N. Find its acceleration and explain your reasoning.",
        material=(
            "Newton's second law states that the net force on an object equals its mass times its acceleration: F = ma. "
            "Acceleration is in the direction of the net force.",
            "If the net force is zero, the object's velocity does not change (Newton's first law).",
        ),
        concepts=("Newton's second law", "net force", "acceleration"),
        student_work="F = ma so a = F / m = 10 / 2 = 5 m/s^2 in the direction of the push.",
        good={
            "EXPLAIN": "What does Newton's second law say about how net force, mass and acceleration are related?",
            "MODIFY": "What would happen to the cart's acceleration if the same net force pushed a 4 kg cart instead, and why?",
            "TRANSFER": "Why does a fully loaded shopping trolley speed up more slowly than an empty one when pushed equally hard?",
        },
        bad=("Why does Newtonian dynamics work in your solution?", "Why does net force work in your essay about Rome?"),
    ),
    Lesson(
        key="chemistry_equilibrium",
        title="Chemical Equilibrium and Le Chatelier's Principle",
        subject_area="chemistry",
        instructions="Explain what happens to the equilibrium N2 + 3H2 ⇌ 2NH3 when the pressure is increased.",
        material=(
            "A reversible reaction is at equilibrium when the forward and reverse reaction rates are equal, so concentrations stay "
            "constant.",
            "Le Chatelier's principle: if a system at equilibrium is disturbed by a change in concentration, temperature or pressure, "
            "the equilibrium shifts to counteract the change. Increasing pressure shifts the equilibrium toward the side with fewer "
            "moles of gas.",
        ),
        concepts=("chemical equilibrium", "Le Chatelier's principle"),
        student_work=("Increasing the pressure pushes the equilibrium to the right because there are 2 moles of gas on the right and 4 "
                      "on the left, so more ammonia forms."),
        good={
            "EXPLAIN": "What is true about the forward and reverse reaction rates when a reaction is at equilibrium?",
            "MODIFY": "Why does increasing the pressure shift this equilibrium toward the side with fewer moles of gas?",
            "TRANSFER": "In the reaction H2 + I2 ⇌ 2HI, what effect would increasing the pressure have on the equilibrium, and why?",
        },
        bad=("Why does chemical equilibrium work in your code?", "Why does the principle of Le Chatelier work in your solution?"),
    ),
    Lesson(
        key="theory_writing",
        title="Academic Writing: Thesis Statements",
        subject_area="academic writing",
        instructions="Write a thesis statement for an essay on remote work and explain why it is arguable.",
        material=(
            "A thesis statement is a one- or two-sentence claim that states the essay's main argument. A strong thesis is specific, "
            "arguable (a reasonable person could disagree) and previews the essay's main points.",
            "A statement of fact is not a thesis because it cannot be argued.",
        ),
        concepts=("thesis statement", "arguable claim"),
        student_work="Remote work improves productivity for knowledge workers because it removes commuting, reduces interruptions and lets people work when they focus best.",
        good={
            "EXPLAIN": "What makes a thesis statement different from a simple statement of fact?",
            "MODIFY": "Why does a thesis need to be arguable for an essay to be persuasive?",
            "TRANSFER": "How would you turn the fact 'many students use phones in class' into an arguable thesis statement?",
        },
        bad=("Why does thesis statement work in your solution?", "Why does the theory of academic writing work?"),
    ),
    # --------------------------------------------------------------------------------------------------- difficult cases
    Lesson(
        key="short_lesson",
        title="Photosynthesis",
        subject_area="biology",
        instructions="Explain photosynthesis.",
        material=(),
        concepts=("photosynthesis",),
        student_work="",
        good={
            "EXPLAIN": "In your own words, what is photosynthesis and what does a plant need for it?",
            "MODIFY": "Why does a plant kept in the dark stop producing glucose by photosynthesis?",
            "TRANSFER": "Why do aquarium plants usually need a light above the tank to stay healthy?",
        },
        bad=("Why does photosynthesis work in your solution?", "Explain this?"),
    ),
    Lesson(
        key="long_multi_concept",
        title="Training Linear Models with Gradient Descent",
        subject_area="machine learning",
        instructions=("Implement batch gradient descent for linear regression. Report the loss every 100 iterations, try learning rates "
                      "0.001, 0.01 and 0.5, and explain which works best and why."),
        material=(
            "The mean squared error loss measures the average squared difference between predictions and targets.",
            "Gradient descent updates each parameter in the direction opposite to the gradient of the loss: θ := θ − α∇J(θ), where α "
            "is the learning rate.",
            "If the learning rate is too small, training converges very slowly; if it is too large, the updates overshoot the minimum "
            "and the loss can diverge.",
            "Feature scaling puts features on similar ranges so that a single learning rate works well for every parameter.",
        ),
        concepts=("gradient_descent", "learning_rate", "mean squared error", "feature scaling"),
        student_work="for i in range(1000):\n    grad = X.T @ (X @ theta - y) / m\n    theta = theta - lr * grad\n# lr=0.5 diverged, lr=0.01 worked best",
        is_programming=True,
        good={
            "EXPLAIN": "Why does the update in your loop subtract the gradient from theta rather than add it?",
            "MODIFY": "Why did a learning rate of 0.5 make your loss diverge while 0.01 converged?",
            "TRANSFER": "How would feature scaling help if one feature ranged from 0 to 1 and another from 0 to 10,000?",
        },
        bad=("Why does gradient_descent work in your solution?", "What changes if learning_rate is modified or reversed?"),
    ),
    Lesson(
        key="missing_context",
        title="",
        subject_area="",
        instructions="",
        material=(),
        concepts=("recursion",),
        student_work="",
        good={
            "EXPLAIN": "What is recursion, and what stops a recursive function from calling itself forever?",
            "MODIFY": "Why does a recursive function without a base case never finish?",
            "TRANSFER": "How could you use recursion to add up the numbers from 1 to n?",
        },
        bad=("Why does recursion work in your solution?", "Where else could you apply recursion?"),
    ),
    Lesson(
        key="arabic_kidney",
        title="تشريح الكلية",
        subject_area="علم التشريح",
        instructions="اشرح تركيب الكلية ودور النفرون في تكوين البول.",
        material=("الوحدة الوظيفية للكلية هي النفرون. يتكون البول عبر الترشيح في الكبيبة ثم إعادة الامتصاص ثم الإفراز.",),
        concepts=("النفرون",),
        student_work="الكلية تتكون من القشرة واللب والحوض، والنفرون يرشح الدم.",
        good={
            "EXPLAIN": "ما هي الوحدة الوظيفية للكلية، وما دورها في تكوين البول؟",
            "MODIFY": "لماذا تعد إعادة الامتصاص خطوة مهمة بعد الترشيح في النفرون؟",
            "TRANSFER": "ماذا يحدث لتكوين البول إذا توقفت الكبيبة عن ترشيح الدم؟",
        },
        bad=(),
    ),
)

LESSONS_BY_KEY = {l.key: l for l in LESSONS}
